package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"cloud.google.com/go/storage"
	"golang.org/x/oauth2"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
)

// ---------------------------------------------------------------------------
// Project root (resolved at startup)
// ---------------------------------------------------------------------------

var projectRoot string

// ---------------------------------------------------------------------------
// Google Translate API v2 response structures
// ---------------------------------------------------------------------------

type translateResponse struct {
	Data struct {
		Translations []struct {
			TranslatedText string `json:"translatedText"`
		} `json:"translations"`
	} `json:"data"`
}

// ---------------------------------------------------------------------------
// Google Cloud TTS API structures
// ---------------------------------------------------------------------------

type ttsRequest struct {
	Input struct {
		Text string `json:"text"`
	} `json:"input"`
	Voice struct {
		LanguageCode string `json:"languageCode"`
		Name         string `json:"name"`
	} `json:"voice"`
	AudioConfig struct {
		AudioEncoding string `json:"audioEncoding"`
	} `json:"audioConfig"`
}

type ttsResponse struct {
	AudioContent string `json:"audioContent"`
	Error        *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

var (
	cache        sync.Map // translate cache: "sl:tl:text" → translated string
	ttsCache     sync.Map // TTS cache: text → MP3 file path on disk
	vocabularyMu sync.Mutex

	// Firestore + GCS global clients for TTS cloud sync
	firestoreClient *firestore.Client
	gcsClientGlobal *storage.Client
	gcsBucketName   string // populated in main()
)

// ---------------------------------------------------------------------------
// Load .env (minimal parser, no third-party deps)
// ---------------------------------------------------------------------------

func loadEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return // silently skip if .env missing
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		// strip surrounding quotes
		val = strings.Trim(val, `"'`)
		os.Setenv(key, val)
	}
}

// ---------------------------------------------------------------------------
// Disk cache: translations  →  data/translate_server/cache.json
// ---------------------------------------------------------------------------

func translateCachePath() string {
	return filepath.Join(projectRoot, "data", "translate_server", "cache.json")
}

// loadTranslateCache reads the JSON cache file into the sync.Map
func loadTranslateCache() {
	path := translateCachePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return // no cache file yet
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		log.Printf("[cache] failed to parse %s: %v", path, err)
		return
	}
	for k, v := range m {
		cache.Store(k, v)
	}
	log.Printf("[cache] loaded %d translations from disk", len(m))
}

// saveTranslateCache writes the full sync.Map out to disk
func saveTranslateCache() {
	m := make(map[string]string)
	cache.Range(func(k, v any) bool {
		m[k.(string)] = v.(string)
		return true
	})
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		log.Printf("[cache] marshal error: %v", err)
		return
	}
	dir := filepath.Dir(translateCachePath())
	os.MkdirAll(dir, 0755)
	if err := os.WriteFile(translateCachePath(), data, 0644); err != nil {
		log.Printf("[cache] write error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Disk cache: TTS audio  →  data/tts_cache/<hash>.mp3
// (shared with gsay)
// ---------------------------------------------------------------------------

func ttsCacheDir() string {
	return filepath.Join(projectRoot, "data", "tts_cache")
}

func textHash(text string) string {
	h := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%x", h)[:16]
}

// loadTTSCache scans existing MP3 files and their index
func loadTTSCache() {
	dir := ttsCacheDir()
	indexPath := filepath.Join(dir, "index.json")
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return
	}
	var m map[string]string // text → filename
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	count := 0
	for text, filename := range m {
		mp3Path := filepath.Join(dir, filename)
		if _, err := os.Stat(mp3Path); err == nil {
			ttsCache.Store(text, mp3Path)
			count++
		}
	}
	log.Printf("[tts cache] loaded %d entries from disk", count)
}

// saveTTSAudio writes MP3 to disk and updates the index
func saveTTSAudio(text string, audioBytes []byte) string {
	dir := ttsCacheDir()
	os.MkdirAll(dir, 0755)

	filename := textHash(text) + ".mp3"
	mp3Path := filepath.Join(dir, filename)

	if err := os.WriteFile(mp3Path, audioBytes, 0644); err != nil {
		log.Printf("[tts cache] write error: %v", err)
		return ""
	}

	// Update index.json
	indexPath := filepath.Join(dir, "index.json")
	m := make(map[string]string)
	if data, err := os.ReadFile(indexPath); err == nil {
		json.Unmarshal(data, &m)
	}
	m[text] = filename
	if data, err := json.MarshalIndent(m, "", "  "); err == nil {
		os.WriteFile(indexPath, data, 0644)
	}

	// Async sync to Firestore + GCS (non-blocking)
	go syncToCloud(text, filename, audioBytes)

	return mp3Path
}

// ---------------------------------------------------------------------------
// Cloud sync: upload MP3 to GCS + write Firestore document
// ---------------------------------------------------------------------------

func syncToCloud(text, filename string, audioBytes []byte) {
	if gcsClientGlobal == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 1. Upload mp3 to GCS
	gcsPath := "tts/" + filename
	w := gcsClientGlobal.Bucket(gcsBucketName).Object(gcsPath).NewWriter(ctx)
	w.ContentType = "audio/mpeg"
	w.CacheControl = "public, max-age=31536000"
	if _, err := w.Write(audioBytes); err != nil {
		log.Printf("[cloud sync] GCS write error: %v", err)
		w.Close()
		return
	}
	if err := w.Close(); err != nil {
		log.Printf("[cloud sync] GCS close error: %v", err)
		return
	}

	// 2. Write Firestore document
	if firestoreClient != nil {
		docID := textHash(text)
		_, err := firestoreClient.Collection("tts_cache").Doc(docID).Set(ctx, map[string]interface{}{
			"text":      text,
			"filename":  filename,
			"gcsPath":   gcsPath,
			"createdAt": firestore.ServerTimestamp,
		})
		if err != nil {
			log.Printf("[cloud sync] Firestore write error: %v", err)
		} else {
			log.Printf("[cloud sync] synced: %s → %s", text, gcsPath)
		}
	}
}

// ---------------------------------------------------------------------------
// One-time migration: upload existing tts_cache to GCS + Firestore
// ---------------------------------------------------------------------------

func migrateExistingTTSToCloud() {
	if gcsClientGlobal == nil || firestoreClient == nil {
		log.Println("[migrate] skipped – cloud clients not initialized")
		return
	}

	dir := ttsCacheDir()
	indexPath := filepath.Join(dir, "index.json")
	data, err := os.ReadFile(indexPath)
	if err != nil {
		log.Println("[migrate] no index.json found, skipping")
		return
	}

	var m map[string]string // text → filename
	if err := json.Unmarshal(data, &m); err != nil {
		log.Printf("[migrate] index.json parse error: %v", err)
		return
	}

	log.Printf("[migrate] starting migration of %d entries...", len(m))

	migrated, skipped, failed := 0, 0, 0
	for text, filename := range m {
		docID := textHash(text)

		// Check if already in Firestore
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		doc, err := firestoreClient.Collection("tts_cache").Doc(docID).Get(ctx)
		cancel()
		if err == nil && doc.Exists() {
			skipped++
			continue
		}

		// Read local mp3
		mp3Path := filepath.Join(dir, filename)
		audioBytes, err := os.ReadFile(mp3Path)
		if err != nil {
			log.Printf("[migrate] read error %s: %v", filename, err)
			failed++
			continue
		}

		syncToCloud(text, filename, audioBytes)
		migrated++

		// Throttle to avoid overwhelming the API
		if migrated%50 == 0 {
			log.Printf("[migrate] progress: %d migrated, %d skipped, %d failed", migrated, skipped, failed)
			time.Sleep(500 * time.Millisecond)
		}
	}

	log.Printf("[migrate] done: %d migrated, %d skipped, %d failed (total %d)", migrated, skipped, failed, len(m))
}

// ---------------------------------------------------------------------------
// Call Google Translate API v2
// ---------------------------------------------------------------------------

func translate(apiKey, text, sl, tl string) (string, error) {
	endpoint := "https://translation.googleapis.com/language/translate/v2"

	params := url.Values{}
	params.Set("key", apiKey)
	params.Set("q", text)
	params.Set("source", sl)
	params.Set("target", tl)
	params.Set("format", "text")

	resp, err := http.Get(endpoint + "?" + params.Encode())
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read body failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var result translateResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("JSON decode failed: %w", err)
	}

	if len(result.Data.Translations) == 0 {
		return "", fmt.Errorf("no translation returned")
	}

	return result.Data.Translations[0].TranslatedText, nil
}

// ---------------------------------------------------------------------------
// Call Google Cloud TTS API  (en-AU-Standard-A, Australian female)
// ---------------------------------------------------------------------------

func synthesizeTTS(apiKey, text string) ([]byte, error) {
	apiURL := "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + apiKey

	req := ttsRequest{}
	req.Input.Text = text
	req.Voice.LanguageCode = "en-AU"
	req.Voice.Name = "en-AU-Standard-A"
	req.AudioConfig.AudioEncoding = "MP3"

	jsonData, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("JSON encode failed: %w", err)
	}

	resp, err := http.Post(apiURL, "application/json", bytes.NewReader(jsonData))
	if err != nil {
		return nil, fmt.Errorf("TTS request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read TTS body failed: %w", err)
	}

	var ttsResp ttsResponse
	if err := json.Unmarshal(body, &ttsResp); err != nil {
		return nil, fmt.Errorf("TTS JSON decode failed: %w", err)
	}
	if ttsResp.Error != nil {
		return nil, fmt.Errorf("TTS API error: %s", ttsResp.Error.Message)
	}

	audioBytes, err := base64.StdEncoding.DecodeString(ttsResp.AudioContent)
	if err != nil {
		return nil, fmt.Errorf("base64 decode failed: %w", err)
	}

	return audioBytes, nil
}

// ---------------------------------------------------------------------------
// playLocal – get or synthesize TTS, play via afplay (non-blocking goroutine)
// ---------------------------------------------------------------------------

func playLocal(ttsKey, text string) {
	go func() {
		// 1. Check disk/memory cache for existing MP3 file
		if cachedPath, ok := ttsCache.Load(text); ok {
			mp3Path := cachedPath.(string)
			if _, err := os.Stat(mp3Path); err == nil {
				log.Printf("[tts disk hit] %s", text)
				exec.Command("afplay", mp3Path).Run()
				return
			}
		}

		// 2. Call TTS API
		audioBytes, err := synthesizeTTS(ttsKey, text)
		if err != nil {
			log.Printf("[tts error] %v", err)
			return
		}

		// 3. Save to disk cache
		mp3Path := saveTTSAudio(text, audioBytes)
		if mp3Path != "" {
			ttsCache.Store(text, mp3Path)
			log.Printf("[tts cached] %s → %s", text, mp3Path)
			exec.Command("afplay", mp3Path).Run()
		}
	}()
}

// ---------------------------------------------------------------------------
// HTML templates (inline CSS, large font)
// ---------------------------------------------------------------------------

func renderSuccess(text, translated, sl, tl string, alreadySaved bool) string {
	// Build play button (only for English source)
	playBtn := ""
	if strings.HasPrefix(strings.ToLower(sl), "en") {
		playBtn = fmt.Sprintf(`
    <button id="playBtn" onclick="playTTS()" style="
      padding:16px 48px; font-size:28px;
      border:none; border-radius:16px; cursor:pointer;
      background:linear-gradient(135deg,rgba(167,139,250,0.3),rgba(96,165,250,0.3));
      color:#e0e0e0; transition:all 0.25s ease;
      display:inline-flex; align-items:center; gap:12px;
      box-shadow:0 4px 16px rgba(0,0,0,0.3);
    " onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 6px 24px rgba(167,139,250,0.4)'"
       onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 4px 16px rgba(0,0,0,0.3)'"
    >🔊 Play</button>
    <script>
    function playTTS(){
      var btn=document.getElementById('playBtn');
      btn.innerText='🔊 Playing...';
      btn.disabled=true;
      btn.style.opacity='0.6';
      fetch('/play?text=%s')
        .then(function(){btn.innerText='🔊 Play';btn.disabled=false;btn.style.opacity='1';})
        .catch(function(){btn.innerText='🔊 Play';btn.disabled=false;btn.style.opacity='1';});
    }
    </script>`, url.QueryEscape(text))
	}

	saveBtn := `
    <span id="saveStatus" style="
      padding:16px 48px; font-size:28px;
      border-radius:16px;
      background:linear-gradient(135deg,rgba(74,222,128,0.2),rgba(34,197,94,0.2));
      color:#bbf7d0;
      display:inline-flex; align-items:center; gap:12px;
      border:1px solid rgba(187,247,208,0.25);
    ">✅ 已在错题本</span>`
	if !alreadySaved {
		saveBtn = fmt.Sprintf(`
    <button id="saveBtn" onclick="saveWord()" style="
      padding:16px 48px; font-size:28px;
      border:none; border-radius:16px; cursor:pointer;
      background:linear-gradient(135deg,rgba(74,222,128,0.3),rgba(59,130,246,0.3));
      color:#e0e0e0; transition:all 0.25s ease;
      display:inline-flex; align-items:center; gap:12px;
      box-shadow:0 4px 16px rgba(0,0,0,0.3);
    " onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 6px 24px rgba(74,222,128,0.4)'"
       onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 4px 16px rgba(0,0,0,0.3)'"
    >➕ 加入错题本</button>
    <script>
    function showSavedStatus(label){
      var btn=document.getElementById('saveBtn');
      if(!btn){return;}
      var status=document.createElement('span');
      status.id='saveStatus';
      status.innerText=label;
      status.setAttribute('style',
        'padding:16px 48px; font-size:28px; border-radius:16px;' +
        'background:linear-gradient(135deg,rgba(74,222,128,0.2),rgba(34,197,94,0.2));' +
        'color:#bbf7d0; display:inline-flex; align-items:center; gap:12px;' +
        'border:1px solid rgba(187,247,208,0.25);'
      );
      btn.replaceWith(status);
    }
    function saveWord(){
      var btn=document.getElementById('saveBtn');
      btn.innerText='保存中...';
      btn.disabled=true;
      btn.style.opacity='0.6';
      fetch('/save?text=%s&translated=%s&sl=%s')
        .then(function(res){
          return res.text().then(function(body){return {ok:res.ok, body:body};});
        })
        .then(function(result){
          if(result.ok){
            showSavedStatus(result.body === 'exists' ? '✅ 已在错题本' : '✅ 已加入错题本');
          }else{
            btn.innerText='保存失败';
            btn.disabled=false;
            btn.style.opacity='1';
          }
        })
        .catch(function(){
            btn.innerText='保存失败';
            btn.disabled=false;
            btn.style.opacity='1';
        });
    }
    </script>`, url.QueryEscape(text), url.QueryEscape(translated), url.QueryEscape(sl))
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Translate</title>
</head>
<body style="
  margin:0; min-height:100vh;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);
  font-family:'Segoe UI',system-ui,sans-serif; color:#e0e0e0;
">
  <div style="
    background:rgba(255,255,255,0.06);
    backdrop-filter:blur(12px);
    border:1px solid rgba(255,255,255,0.12);
    border-radius:24px; padding:48px 56px;
    max-width:680px; width:90%%;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
    text-align:center;
  ">
    <p style="font-size:14px;opacity:0.5;margin:0 0 8px;letter-spacing:2px;">%s → %s</p>
    <p style="font-size:42px;font-weight:700;margin:0 0 16px;
              background:linear-gradient(90deg,#a78bfa,#60a5fa);
              -webkit-background-clip:text;-webkit-text-fill-color:transparent;">%s</p>
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:20px 0;">
    <p style="font-size:36px;font-weight:400;margin:0;color:#c4b5fd;">%s</p>
    <div style="margin-top:28px; display:flex; justify-content:center; gap:16px; flex-wrap:wrap;">
      %s
      %s
    </div>
  </div>
</body>
</html>`,
		htmlEscape(strings.ToUpper(sl)),
		htmlEscape(strings.ToUpper(tl)),
		htmlEscape(text),
		htmlEscape(translated),
		playBtn,
		saveBtn,
	)
}

func renderError(msg string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
</head>
<body style="
  margin:0; min-height:100vh;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,#1a0000,#4a1942,#1a0000);
  font-family:'Segoe UI',system-ui,sans-serif; color:#e0e0e0;
">
  <div style="
    background:rgba(255,60,60,0.08);
    backdrop-filter:blur(12px);
    border:1px solid rgba(255,100,100,0.2);
    border-radius:24px; padding:48px 56px;
    max-width:600px; width:90%%;
    box-shadow:0 8px 32px rgba(0,0,0,0.5);
    text-align:center;
  ">
    <p style="font-size:48px;margin:0 0 12px;">⚠️</p>
    <p style="font-size:24px;font-weight:600;margin:0 0 16px;color:#fca5a5;">Something went wrong</p>
    <p style="font-size:16px;opacity:0.7;margin:0;">%s</p>
  </div>
</body>
</html>`, htmlEscape(msg))
}

// htmlEscape without html/template – just the 5 XML entities
func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}

func vocabularyPath() string {
	return filepath.Join(projectRoot, "data", "vocabulary.csv")
}

func normalizeVocabText(s string) string {
	s = strings.TrimPrefix(strings.TrimSpace(s), "\ufeff")
	return strings.Join(strings.Fields(s), " ")
}

func vocabularyKey(s string) string {
	return strings.ToLower(normalizeVocabText(s))
}

func vocabularyEntry(text, translated, sl string) (string, string) {
	text = normalizeVocabText(text)
	translated = normalizeVocabText(translated)
	if strings.HasPrefix(strings.ToLower(sl), "en") {
		return text, translated
	}
	return translated, text
}

func vocabularyContains(en string) (bool, error) {
	vocabularyMu.Lock()
	defer vocabularyMu.Unlock()
	return vocabularyContainsLocked(en)
}

func vocabularyContainsLocked(en string) (bool, error) {
	key := vocabularyKey(en)
	if key == "" {
		return false, nil
	}

	f, err := os.Open(vocabularyPath())
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true

	for {
		record, err := reader.Read()
		if err == io.EOF {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if len(record) == 0 {
			continue
		}
		if vocabularyKey(record[0]) == key {
			return true, nil
		}
	}
}

func isVocabularySaved(text, translated, sl string) bool {
	en, _ := vocabularyEntry(text, translated, sl)
	exists, err := vocabularyContains(en)
	if err != nil {
		log.Printf("[vocab check error] %v", err)
	}
	return exists
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

func translateHandler(translateKey, ttsKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, renderError("Page not found"))
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusMethodNotAllowed)
			fmt.Fprint(w, renderError("Only GET is allowed"))
			return
		}

		q := r.URL.Query()
		text := q.Get("text")
		sl := q.Get("sl")
		tl := q.Get("tl")

		if text == "" || sl == "" || tl == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, renderError("Missing required query parameters: text, sl, tl"))
			return
		}

		// Play TTS locally if source is English (non-blocking)
		if strings.HasPrefix(strings.ToLower(sl), "en") {
			playLocal(ttsKey, text)
		}

		// Cache lookup
		cacheKey := sl + ":" + tl + ":" + text
		if cached, ok := cache.Load(cacheKey); ok {
			translated := cached.(string)
			log.Printf("[cache hit] %s", cacheKey)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, renderSuccess(text, translated, sl, tl, isVocabularySaved(text, translated, sl)))
			return
		}

		// Call API
		translated, err := translate(translateKey, text, sl, tl)
		if err != nil {
			log.Printf("[error] %v", err)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, renderError(err.Error()))
			return
		}

		// Store in memory + disk cache
		cache.Store(cacheKey, translated)
		saveTranslateCache()
		log.Printf("[translated] %s → %s", text, translated)

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, renderSuccess(text, translated, sl, tl, isVocabularySaved(text, translated, sl)))
	}
}

// ---------------------------------------------------------------------------
// Play handler – GET /play?text=hello → triggers local afplay
// ---------------------------------------------------------------------------

func playHandler(ttsKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		text := r.URL.Query().Get("text")
		if text == "" {
			http.Error(w, "missing text", http.StatusBadRequest)
			return
		}
		playLocal(ttsKey, text)
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	}
}

// ---------------------------------------------------------------------------
// Save handler – GET/POST /save?text=X&translated=Y&sl=Z → appends to data/vocabulary.csv if missing
// ---------------------------------------------------------------------------

func saveHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			http.Error(w, "only GET or POST is allowed", http.StatusMethodNotAllowed)
			return
		}

		text := r.URL.Query().Get("text")
		translated := r.URL.Query().Get("translated")
		sl := r.URL.Query().Get("sl")

		if text == "" || translated == "" || sl == "" {
			http.Error(w, "missing text, translated, or sl", http.StatusBadRequest)
			return
		}

		en, zh := vocabularyEntry(text, translated, sl)
		if en == "" || zh == "" {
			http.Error(w, "empty vocabulary entry", http.StatusBadRequest)
			return
		}

		dataDir := filepath.Join(projectRoot, "data")
		if err := os.MkdirAll(dataDir, 0755); err != nil {
			log.Printf("[save error] %v", err)
			http.Error(w, "failed to create data directory", http.StatusInternalServerError)
			return
		}

		vocabularyMu.Lock()
		defer vocabularyMu.Unlock()

		exists, err := vocabularyContainsLocked(en)
		if err != nil {
			log.Printf("[save error] %v", err)
			http.Error(w, "failed to read vocabulary", http.StatusInternalServerError)
			return
		}
		if exists {
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, "exists")
			return
		}

		f, err := os.OpenFile(vocabularyPath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			log.Printf("[save error] %v", err)
			http.Error(w, "failed to open file", http.StatusInternalServerError)
			return
		}
		defer f.Close()

		writer := csv.NewWriter(f)
		if err := writer.Write([]string{en, zh}); err != nil {
			log.Printf("[save error] %v", err)
			http.Error(w, "failed to write csv", http.StatusInternalServerError)
			return
		}
		writer.Flush()

		if err := writer.Error(); err != nil {
			log.Printf("[save error] %v", err)
			http.Error(w, "failed to flush csv", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	}
}

// ---------------------------------------------------------------------------
// GCS helpers
// ---------------------------------------------------------------------------

// resolveCredentials finds the service account JSON file.
// Search order: GOOGLE_APPLICATION_CREDENTIALS, credentials/, legacy cmd path, then project root.
func resolveCredentials() string {
	if envPath := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")); envPath != "" {
		if abs, err := filepath.Abs(envPath); err == nil {
			return abs
		}
		return envPath
	}

	candidateDirs := []string{
		filepath.Join(projectRoot, "credentials"),
		filepath.Join(projectRoot, "cmd", "translate_server", "credentials"),
		projectRoot,
	}
	for _, dir := range candidateDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "vertex-") && strings.HasSuffix(e.Name(), ".json") {
				return filepath.Join(dir, e.Name())
			}
		}
	}
	return ""
}

func newGCSClient(ctx context.Context, credPath string) (*storage.Client, error) {
	if credPath != "" {
		return storage.NewClient(ctx, option.WithCredentialsFile(credPath))
	}
	if os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" {
		return storage.NewClient(ctx)
	}
	return nil, fmt.Errorf("GCS credentials not found; put vertex-*.json under credentials/ or set GOOGLE_APPLICATION_CREDENTIALS")
}

// GCSFileInfo is returned by /gcs/list
type GCSFileInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type GCSListResponse struct {
	Bucket string        `json:"bucket"`
	Prefix string        `json:"prefix"`
	Files  []GCSFileInfo `json:"files"`
}

func writeCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// gcsListHandler – GET /gcs/list → JSON array of files under the configured prefix
func gcsListHandler(bucketName, prefix, credPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "only GET is allowed", http.StatusMethodNotAllowed)
			return
		}
		if bucketName == "" {
			http.Error(w, "GCS bucket is not configured", http.StatusInternalServerError)
			return
		}

		ctx := context.Background()
		client, err := newGCSClient(ctx, credPath)
		if err != nil {
			log.Printf("[gcs list] client error: %v", err)
			http.Error(w, "GCS client error", http.StatusInternalServerError)
			return
		}
		defer client.Close()

		var files []GCSFileInfo
		it := client.Bucket(bucketName).Objects(ctx, &storage.Query{Prefix: prefix})
		for {
			attrs, err := it.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				log.Printf("[gcs list] iterator error: %v", err)
				http.Error(w, "GCS list error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			// Skip "directory" markers (zero-size objects ending with /)
			if strings.HasSuffix(attrs.Name, "/") {
				continue
			}
			// Return the name relative to the prefix for cleaner display
			displayName := strings.TrimPrefix(attrs.Name, prefix)
			if displayName == "" {
				continue
			}
			files = append(files, GCSFileInfo{
				Name: displayName,
				Size: attrs.Size,
			})
		}
		sort.Slice(files, func(i, j int) bool {
			return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
		})

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(GCSListResponse{
			Bucket: bucketName,
			Prefix: prefix,
			Files:  files,
		})
	}
}

// gcsDownloadHandler – GET /gcs/download?name=xxx → file content
func gcsDownloadHandler(bucketName, prefix, credPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "only GET is allowed", http.StatusMethodNotAllowed)
			return
		}
		if bucketName == "" {
			http.Error(w, "GCS bucket is not configured", http.StatusInternalServerError)
			return
		}

		name := r.URL.Query().Get("name")
		if name == "" {
			http.Error(w, "missing name parameter", http.StatusBadRequest)
			return
		}

		// Security: prevent path traversal
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "\\") {
			http.Error(w, "invalid name", http.StatusBadRequest)
			return
		}

		objectName := prefix + name

		ctx := context.Background()
		client, err := newGCSClient(ctx, credPath)
		if err != nil {
			log.Printf("[gcs download] client error: %v", err)
			http.Error(w, "GCS client error", http.StatusInternalServerError)
			return
		}
		defer client.Close()

		reader, err := client.Bucket(bucketName).Object(objectName).NewReader(ctx)
		if err != nil {
			log.Printf("[gcs download] read error for %s: %v", objectName, err)
			http.Error(w, "file not found: "+err.Error(), http.StatusNotFound)
			return
		}
		defer reader.Close()

		// Determine content type from extension
		ext := filepath.Ext(name)
		contentType := mime.TypeByExtension(ext)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, filepath.Base(name)))

		if _, err := io.Copy(w, reader); err != nil {
			log.Printf("[gcs download] copy error: %v", err)
		}
	}
}

// lexicaHandler – GET /lexica → serves lexica.html from cmd/translate_server/
func lexicaHandler() http.HandlerFunc {
	return lexicaAssetHandler("lexica.html", "text/html; charset=utf-8")
}

// lexicaAssetHandler – generic static-file handler for lexica's bundle
// (html/css/js). Reads from cmd/translate_server/<filename>.
func lexicaAssetHandler(filename, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(projectRoot, "cmd", "translate_server", filename)
		data, err := os.ReadFile(path)
		if err != nil {
			log.Printf("[lexica] read %s error: %v", filename, err)
			http.Error(w, filename+" not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	}
}

// ---------------------------------------------------------------------------
// Dictation endpoints
// ---------------------------------------------------------------------------

const gcsDailyWordPrefix = "study-english/vocabulary-list/daily_english_word/"

// dictationDaysHandler – GET /dictation/days → JSON list of available day numbers
func dictationDaysHandler(bucketName, credPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		ctx := context.Background()
		client, err := newGCSClient(ctx, credPath)
		if err != nil {
			log.Printf("[dictation/days] client error: %v", err)
			http.Error(w, "GCS client error", http.StatusInternalServerError)
			return
		}
		defer client.Close()

		var days []string
		it := client.Bucket(bucketName).Objects(ctx, &storage.Query{Prefix: gcsDailyWordPrefix})
		for {
			attrs, err := it.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				log.Printf("[dictation/days] iterator error: %v", err)
				http.Error(w, "GCS error", http.StatusInternalServerError)
				return
			}
			name := strings.TrimPrefix(attrs.Name, gcsDailyWordPrefix)
			if strings.HasSuffix(name, ".txt") && !strings.Contains(name, "/") {
				days = append(days, strings.TrimSuffix(name, ".txt"))
			}
		}
		sort.Strings(days)

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(days)
	}
}

// DictationWord is a single word entry returned to the frontend
type DictationWord struct {
	English string `json:"english"`
	Chinese string `json:"chinese"`
}

// dictationWordsHandler – GET /dictation/words?day=XX → JSON word list
func dictationWordsHandler(bucketName, credPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		day := r.URL.Query().Get("day")
		if day == "" {
			http.Error(w, "missing day parameter", http.StatusBadRequest)
			return
		}

		objectName := gcsDailyWordPrefix + day + ".txt"

		ctx := context.Background()
		client, err := newGCSClient(ctx, credPath)
		if err != nil {
			log.Printf("[dictation/words] client error: %v", err)
			http.Error(w, "GCS client error", http.StatusInternalServerError)
			return
		}
		defer client.Close()

		reader, err := client.Bucket(bucketName).Object(objectName).NewReader(ctx)
		if err != nil {
			log.Printf("[dictation/words] read error for %s: %v", objectName, err)
			http.Error(w, "file not found: "+day+".txt", http.StatusNotFound)
			return
		}
		defer reader.Close()

		data, err := io.ReadAll(reader)
		if err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}

		var words []DictationWord
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				words = append(words, DictationWord{
					English: fields[0],
					Chinese: strings.Join(fields[1:], " "),
				})
			}
		}

		log.Printf("[dictation] loaded %d words from %s", len(words), objectName)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(words)
	}
}

// dictationTTSHandler – GET /dictation/tts?text=X → MP3 audio
// Uses the same TTS cache as gsay / translate_server play
func dictationTTSHandler(ttsKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		text := r.URL.Query().Get("text")
		if text == "" {
			http.Error(w, "missing text", http.StatusBadRequest)
			return
		}

		// 1. Check disk/memory cache
		if cachedPath, ok := ttsCache.Load(text); ok {
			mp3Path := cachedPath.(string)
			if data, err := os.ReadFile(mp3Path); err == nil {
				log.Printf("[dictation tts cache hit] %s", text)
				w.Header().Set("Content-Type", "audio/mpeg")
				w.Header().Set("Cache-Control", "public, max-age=86400")
				w.Write(data)
				return
			}
		}

		// 2. Synthesize via Google TTS API
		audioBytes, err := synthesizeTTS(ttsKey, text)
		if err != nil {
			log.Printf("[dictation tts error] %v", err)
			http.Error(w, "TTS synthesis failed", http.StatusInternalServerError)
			return
		}

		// 3. Save to disk cache
		mp3Path := saveTTSAudio(text, audioBytes)
		if mp3Path != "" {
			ttsCache.Store(text, mp3Path)
			log.Printf("[dictation tts cached] %s → %s", text, mp3Path)
		}

		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(audioBytes)
	}
}

// ---------------------------------------------------------------------------
// Dictation traces + Gemini AI analysis
// ---------------------------------------------------------------------------

// Default Gemini/Gemma model. Override via GEMINI_MODEL env if needed.
const defaultGeminiModel = "gemma-4-31b-it"

type TraceWord struct {
	English    string   `json:"english"`
	Chinese    string   `json:"chinese"`
	Attempts   []string `json:"attempts"`
	AttemptMs  []int    `json:"attemptMs,omitempty"` // ms per attempt (parallel to Attempts)
	Skipped    bool     `json:"skipped"`
	FirstTryOK bool     `json:"firstTryOK"`
	ErrorCount int      `json:"errorCount"`
	TotalMs    int      `json:"totalMs,omitempty"` // total ms for this word
}

type TraceRecord struct {
	ID              string      `json:"id"`
	Timestamp       string      `json:"timestamp"` // RFC3339 in +08:00
	DayName         string      `json:"dayName"`
	Mode            string      `json:"mode"`
	Words           []TraceWord `json:"words"`
	Total           int         `json:"total"`
	FirstTryCorrect int         `json:"firstTryCorrect"`
	Wrong           int         `json:"wrong"`
}

func tracesDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "traces")
}

// traceRecordHandler – POST /trace/record  (body: TraceRecord JSON)
func traceRecordHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var rec TraceRecord
		if err := json.NewDecoder(r.Body).Decode(&rec); err != nil {
			http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
			return
		}
		loc := time.FixedZone("UTC+8", 8*60*60)
		now := time.Now().In(loc)
		if rec.Timestamp == "" {
			rec.Timestamp = now.Format(time.RFC3339)
		}
		if rec.ID == "" {
			rec.ID = now.Format("20060102-150405") + fmt.Sprintf("-%d", now.UnixNano()%1000)
		}
		if err := os.MkdirAll(tracesDir(), 0755); err != nil {
			log.Printf("[trace mkdir] %v", err)
			http.Error(w, "mkdir failed", http.StatusInternalServerError)
			return
		}
		path := filepath.Join(tracesDir(), rec.ID+".json")
		data, err := json.MarshalIndent(rec, "", "  ")
		if err != nil {
			http.Error(w, "marshal failed", http.StatusInternalServerError)
			return
		}
		if err := os.WriteFile(path, data, 0644); err != nil {
			log.Printf("[trace save] %v", err)
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		log.Printf("[trace saved] %s (%s, %d words)", rec.ID, rec.DayName, len(rec.Words))
		appendActivityLog("dictation", fmt.Sprintf("听写 %s: %d词, 正确%d, 错误%d", rec.DayName, rec.Total, rec.FirstTryCorrect, rec.Wrong), nil)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": rec.ID})
	}
}

type traceListItem struct {
	ID              string `json:"id"`
	Timestamp       string `json:"timestamp"`
	DayName         string `json:"dayName"`
	Mode            string `json:"mode"`
	Total           int    `json:"total"`
	FirstTryCorrect int    `json:"firstTryCorrect"`
	Wrong           int    `json:"wrong"`
}

// traceListHandler – GET /trace/list → JSON array (newest first)
func traceListHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		entries, err := os.ReadDir(tracesDir())
		if err != nil {
			if os.IsNotExist(err) {
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte("[]"))
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		items := []traceListItem{}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(tracesDir(), e.Name()))
			if err != nil {
				continue
			}
			var rec TraceRecord
			if err := json.Unmarshal(data, &rec); err != nil {
				continue
			}
			items = append(items, traceListItem{
				ID: rec.ID, Timestamp: rec.Timestamp, DayName: rec.DayName,
				Mode: rec.Mode, Total: rec.Total,
				FirstTryCorrect: rec.FirstTryCorrect, Wrong: rec.Wrong,
			})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Timestamp > items[j].Timestamp })
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(items)
	}
}

// traceDeleteHandler – DELETE|POST /trace/delete?id=X
func traceDeleteHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodDelete && r.Method != http.MethodPost {
			http.Error(w, "DELETE or POST only", http.StatusMethodNotAllowed)
			return
		}
		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}
		if strings.ContainsAny(id, "/\\") || strings.Contains(id, "..") {
			http.Error(w, "invalid id", http.StatusBadRequest)
			return
		}
		path := filepath.Join(tracesDir(), id+".json")
		if err := os.Remove(path); err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			log.Printf("[trace delete] %v", err)
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		log.Printf("[trace deleted] %s", id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": id, "status": "deleted"})
	}
}

// callGemini calls Google Generative Language API with the given prompt
func callGemini(apiKey, model, prompt string) (string, error) {
	endpoint := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s",
		url.PathEscape(model), url.QueryEscape(apiKey))

	body := map[string]any{
		"contents": []map[string]any{
			{"role": "user", "parts": []map[string]string{{"text": prompt}}},
		},
	}
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	resp, err := http.Post(endpoint, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("gemini %d: %s", resp.StatusCode, string(respBody))
	}
	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("parse: %w (body: %s)", err, string(respBody))
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("empty response: %s", string(respBody))
	}
	var sb strings.Builder
	for _, p := range result.Candidates[0].Content.Parts {
		sb.WriteString(p.Text)
	}
	return sb.String(), nil
}

// traceAskHandler – POST /trace/ask  (body: {ids: [...], question: "..."})
func traceAskHandler(apiKey, model string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if apiKey == "" {
			http.Error(w, "GEMINI_API_KEY not set in .env", http.StatusInternalServerError)
			return
		}
		var req struct {
			IDs      []string `json:"ids"`
			Question string   `json:"question"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		var recs []TraceRecord
		for _, id := range req.IDs {
			// prevent path traversal
			if strings.ContainsAny(id, "/\\") || strings.Contains(id, "..") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(tracesDir(), id+".json"))
			if err != nil {
				continue
			}
			var rec TraceRecord
			if err := json.Unmarshal(data, &rec); err != nil {
				continue
			}
			recs = append(recs, rec)
		}
		if len(recs) == 0 {
			http.Error(w, "no traces matched the given ids", http.StatusBadRequest)
			return
		}
		bodyJSON, _ := json.MarshalIndent(recs, "", "  ")
		question := strings.TrimSpace(req.Question)
		if question == "" {
			question = "请分析以上单词听写练习记录：薄弱点、常见错误模式（拼写、发音相似、混淆词等），并给出针对性的复习建议。用中文回答，简洁清晰。"
		}
		prompt := fmt.Sprintf(
			"你是一名英语单词听写助教。以下是用户的听写练习记录（JSON 格式），"+
				"每个 word 含 english=正确单词、chinese=中文释义、attempts=用户尝试输入的序列、"+
				"skipped=是否跳过、firstTryOK=是否一遍过、errorCount=错误次数。\n\n"+
				"练习数据：\n%s\n\n用户问题：%s",
			string(bodyJSON), question,
		)
		answer, err := callGemini(apiKey, model, prompt)
		if err != nil {
			log.Printf("[trace ask] %v", err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"answer": answer, "model": model})
	}
}

// ---------------------------------------------------------------------------
// LingoCleaner Handler
// ---------------------------------------------------------------------------

const lingoBaseDir = "/Users/jiatongzhou/Public/Drop Box/学外语"
const lingoGcsDailyWordPrefix = "study-english/vocabulary-list/daily_english_word/"

func removeFromTxt(filePath string, targetWord string) bool {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return false
	}
	lines := strings.Split(string(data), "\n")
	var newLines []string
	found := false
	for _, line := range lines {
		fields := strings.Fields(line)
		if !found && len(fields) > 0 && strings.ToLower(fields[0]) == targetWord {
			found = true
			continue
		}
		newLines = append(newLines, line)
	}
	if found {
		os.WriteFile(filePath, []byte(strings.Join(newLines, "\n")), 0644)
	}
	return found
}

func renameAudio(filePath string) {
	if _, err := os.Stat(filePath); err == nil {
		os.Rename(filePath, filePath+".bak")
	}
}

func cleanHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "only POST is allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Words string `json:"words"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}

		changedFiles := make(map[string]string)
		words := strings.Split(req.Words, ",")

		for _, w := range words {
			word := strings.ToLower(strings.TrimSpace(w))
			if word == "" {
				continue
			}
			firstLetter := string(word[0])

			// 1. alphabet_order_word
			removeFromTxt(filepath.Join(lingoBaseDir, "alphabet_order_word", firstLetter+".txt"), word)
			
			// 2. alphabet_order_audio
			renameAudio(filepath.Join(lingoBaseDir, "alphabet_order_audio", firstLetter, word+".mp3"))

			// 3. daily_english_word
			dailyWordDir := filepath.Join(lingoBaseDir, "daily_english_word")
			if entries, err := os.ReadDir(dailyWordDir); err == nil {
				for _, entry := range entries {
					if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".txt") {
						fp := filepath.Join(dailyWordDir, entry.Name())
						if removeFromTxt(fp, word) {
							changedFiles[entry.Name()] = fp
							break
						}
					}
				}
			}

			// 4. daily_english_audio
			dailyAudioDir := filepath.Join(lingoBaseDir, "daily_english_audio")
			if entries, err := os.ReadDir(dailyAudioDir); err == nil {
				for _, entry := range entries {
					if entry.IsDir() && strings.HasPrefix(entry.Name(), "day") {
						ap := filepath.Join(dailyAudioDir, entry.Name(), word+".mp3")
						if _, err := os.Stat(ap); err == nil {
							renameAudio(ap)
							break
						}
					}
				}
			}
		}

		loc := time.FixedZone("UTC+8", 8*60*60)
		nowStr := time.Now().In(loc).Format(time.RFC3339)

		if len(changedFiles) > 0 {
			pendingFile := filepath.Join(projectRoot, "data", "clean_sync_pending.json")
			var records []CleanSyncRecord
			if data, err := os.ReadFile(pendingFile); err == nil {
				json.Unmarshal(data, &records)
			}
			for k, v := range changedFiles {
				records = append(records, CleanSyncRecord{
					FileName:  k,
					LocalPath: v,
					Words:     req.Words,
					CleanedAt: nowStr,
				})
			}
			if data, err := json.MarshalIndent(records, "", "  "); err == nil {
				os.WriteFile(pendingFile, data, 0644)
			}
		}

		// Log the cleaning activity
		var cleanedWords []string
		for _, w := range words {
			w = strings.TrimSpace(w)
			if w != "" {
				cleanedWords = append(cleanedWords, w)
			}
		}
		if len(cleanedWords) > 0 {
			appendActivityLog("clean", fmt.Sprintf("清理单词: %s", strings.Join(cleanedWords, ", ")), nil)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status": "success",
			"cleaned": len(cleanedWords),
			"pending_sync": len(changedFiles),
		})
	}
}

func cleanSyncHandler(gcsBucket, credPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "only POST is allowed", http.StatusMethodNotAllowed)
			return
		}

		pendingFile := filepath.Join(projectRoot, "data", "clean_sync_pending.json")
		var records []CleanSyncRecord
		if data, err := os.ReadFile(pendingFile); err == nil {
			json.Unmarshal(data, &records)
		}

		// Find unsynced records
		unsyncedCount := 0
		for _, r := range records {
			if r.SyncedAt == "" {
				unsyncedCount++
			}
		}
		if unsyncedCount == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"status": "success", "synced": 0})
			return
		}

		ctx := context.Background()
		var client *storage.Client
		if credPath != "" {
			client, _ = storage.NewClient(ctx, option.WithCredentialsFile(credPath))
		} else if os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" {
			client, _ = storage.NewClient(ctx)
		}

		loc := time.FixedZone("UTC+8", 8*60*60)
		synced := 0
		if client != nil {
			for i := range records {
				if records[i].SyncedAt != "" {
					continue
				}
				if data, err := os.ReadFile(records[i].LocalPath); err == nil {
					gcsPath := lingoGcsDailyWordPrefix + records[i].FileName
					writer := client.Bucket(gcsBucket).Object(gcsPath).NewWriter(ctx)
					writer.ContentType = "text/plain; charset=utf-8"
					if _, err := writer.Write(data); err == nil {
						writer.Close()
						records[i].SyncedAt = time.Now().In(loc).Format(time.RFC3339)
						synced++
					} else {
						writer.Close()
					}
				}
			}
			client.Close()
		}

		// Save back with synced_at markers (logical delete)
		if data, err := json.MarshalIndent(records, "", "  "); err == nil {
			os.WriteFile(pendingFile, data, 0644)
		}

		if synced > 0 {
			appendActivityLog("clean_sync", fmt.Sprintf("已同步 %d 个文件到云端", synced), nil)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "success", "synced": synced})
	}
}

// CleanSyncRecord represents a file pending/completed cloud sync (logical delete pattern)
type CleanSyncRecord struct {
	FileName  string `json:"file_name"`
	LocalPath string `json:"local_path"`
	Words     string `json:"words,omitempty"`
	CleanedAt string `json:"cleaned_at"`
	SyncedAt  string `json:"synced_at,omitempty"` // empty = not synced yet
}

// ---------------------------------------------------------------------------
// Activity Log System
// ---------------------------------------------------------------------------

type ActivityLogEntry struct {
	Time    string `json:"time"`
	Type    string `json:"type"` // dictation, clean, clean_sync, email, etc.
	Summary string `json:"summary"`
	Detail  any    `json:"detail,omitempty"`
}

func activityLogDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "activity_logs")
}

func appendActivityLog(logType, summary string, detail any) {
	loc := time.FixedZone("UTC+8", 8*60*60)
	now := time.Now().In(loc)
	entry := ActivityLogEntry{
		Time:    now.Format(time.RFC3339),
		Type:    logType,
		Summary: summary,
		Detail:  detail,
	}

	dir := activityLogDir()
	os.MkdirAll(dir, 0755)

	// One file per day: 2026-05-20.json
	dayFile := filepath.Join(dir, now.Format("2006-01-02")+".json")
	var entries []ActivityLogEntry
	if data, err := os.ReadFile(dayFile); err == nil {
		json.Unmarshal(data, &entries)
	}
	entries = append(entries, entry)
	if data, err := json.MarshalIndent(entries, "", "  "); err == nil {
		os.WriteFile(dayFile, data, 0644)
	}
	log.Printf("[activity] [%s] %s", logType, summary)
}

// purgeOldActivityLogs removes log files older than 10 days
func purgeOldActivityLogs() {
	dir := activityLogDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -10)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		dayStr := strings.TrimSuffix(e.Name(), ".json")
		t, err := time.Parse("2006-01-02", dayStr)
		if err != nil {
			continue
		}
		if t.Before(cutoff) {
			os.Remove(filepath.Join(dir, e.Name()))
			log.Printf("[activity] purged old log: %s", e.Name())
		}
	}
}

func activityLogListHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		dir := activityLogDir()
		entries, err := os.ReadDir(dir)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]ActivityLogEntry{})
			return
		}

		var allLogs []ActivityLogEntry
		// Read most recent 10 days worth of logs
		cutoff := time.Now().AddDate(0, 0, -10)
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			dayStr := strings.TrimSuffix(e.Name(), ".json")
			t, err := time.Parse("2006-01-02", dayStr)
			if err != nil || t.Before(cutoff) {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			var dayEntries []ActivityLogEntry
			if err := json.Unmarshal(data, &dayEntries); err == nil {
				allLogs = append(allLogs, dayEntries...)
			}
		}

		// Sort newest first
		sort.Slice(allLogs, func(i, j int) bool {
			return allLogs[i].Time > allLogs[j].Time
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(allLogs)
	}
}

// ---------------------------------------------------------------------------
// Gmail Daily Report Email (OAuth2)
// ---------------------------------------------------------------------------

func gmailTokenPath() string {
	return filepath.Join(projectRoot, "credentials", "gmail_token.json")
}

func gmailClientSecretPath() string {
	return filepath.Join(projectRoot, "credentials", "gmail_client_secret.json")
}

func loadGmailOAuth2Config() (*oauth2.Config, error) {
	data, err := os.ReadFile(gmailClientSecretPath())
	if err != nil {
		return nil, fmt.Errorf("read client secret: %w", err)
	}
	var creds struct {
		Installed struct {
			ClientID     string   `json:"client_id"`
			ClientSecret string   `json:"client_secret"`
			AuthURI      string   `json:"auth_uri"`
			TokenURI     string   `json:"token_uri"`
			RedirectURIs []string `json:"redirect_uris"`
		} `json:"installed"`
	}
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("parse client secret: %w", err)
	}
	redirectURI := "http://localhost:8080/gmail/callback"
	return &oauth2.Config{
		ClientID:     creds.Installed.ClientID,
		ClientSecret: creds.Installed.ClientSecret,
		Endpoint: oauth2.Endpoint{
			AuthURL:  creds.Installed.AuthURI,
			TokenURL: creds.Installed.TokenURI,
		},
		RedirectURL: redirectURI,
		Scopes:      []string{"https://www.googleapis.com/auth/gmail.send"},
	}, nil
}

func loadSavedToken() (*oauth2.Token, error) {
	data, err := os.ReadFile(gmailTokenPath())
	if err != nil {
		return nil, err
	}
	var tok oauth2.Token
	if err := json.Unmarshal(data, &tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

func saveToken(tok *oauth2.Token) error {
	data, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(gmailTokenPath(), data, 0600)
}

// GET /gmail/auth → redirect to Google OAuth2 consent
func gmailAuthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg, err := loadGmailOAuth2Config()
		if err != nil {
			http.Error(w, "OAuth config error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		authURL := cfg.AuthCodeURL("state-token", oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"))
		http.Redirect(w, r, authURL, http.StatusTemporaryRedirect)
	}
}

// GET /gmail/callback?code=xxx → exchange code for token
func gmailCallbackHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "missing code", http.StatusBadRequest)
			return
		}
		cfg, err := loadGmailOAuth2Config()
		if err != nil {
			http.Error(w, "OAuth config error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		tok, err := cfg.Exchange(context.Background(), code)
		if err != nil {
			http.Error(w, "token exchange failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := saveToken(tok); err != nil {
			http.Error(w, "save token failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		log.Println("[gmail] OAuth2 token saved successfully")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#FAF6EC;">
		<div style="text-align:center"><h1>✅ Gmail 授权成功</h1><p>可以关闭此窗口了。</p></div></body></html>`)
	}
}

// GET /gmail/status → check if Gmail token exists and is valid
func gmailStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		tok, err := loadSavedToken()
		authorized := err == nil && tok != nil
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"authorized": authorized})
	}
}

func buildDailyReport(geminiKey, geminiModel string) (string, error) {
	loc := time.FixedZone("UTC+8", 8*60*60)
	today := time.Now().In(loc).Format("2006-01-02")

	// Collect today's activity logs
	logFile := filepath.Join(activityLogDir(), today+".json")
	var logs []ActivityLogEntry
	if data, err := os.ReadFile(logFile); err == nil {
		json.Unmarshal(data, &logs)
	}

	// Collect today's traces
	var todayTraces []TraceRecord
	trDir := tracesDir()
	if entries, err := os.ReadDir(trDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(trDir, e.Name()))
			if err != nil {
				continue
			}
			var rec TraceRecord
			if json.Unmarshal(data, &rec) == nil && strings.HasPrefix(rec.Timestamp, today) {
				todayTraces = append(todayTraces, rec)
			}
		}
	}

	// Collect cleaned words
	pendingFile := filepath.Join(projectRoot, "data", "clean_sync_pending.json")
	var cleanRecords []CleanSyncRecord
	if data, err := os.ReadFile(pendingFile); err == nil {
		json.Unmarshal(data, &cleanRecords)
	}
	var todayCleaned []CleanSyncRecord
	for _, r := range cleanRecords {
		if strings.HasPrefix(r.CleanedAt, today) {
			todayCleaned = append(todayCleaned, r)
		}
	}

	// Build report content
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("📅 %s 学习日报\n\n", today))

	if len(todayTraces) > 0 {
		totalWords := 0
		correct := 0
		wrong := 0
		for _, t := range todayTraces {
			totalWords += t.Total
			correct += t.FirstTryCorrect
			wrong += t.Wrong
		}
		sb.WriteString(fmt.Sprintf("📝 听写练习: %d 次\n", len(todayTraces)))
		sb.WriteString(fmt.Sprintf("   总计 %d 个单词, 一遍过 %d, 错误 %d\n\n", totalWords, correct, wrong))
	} else {
		sb.WriteString("📝 听写练习: 今日无记录\n\n")
	}

	if len(todayCleaned) > 0 {
		var words []string
		for _, c := range todayCleaned {
			words = append(words, c.Words)
		}
		sb.WriteString(fmt.Sprintf("🧹 学会并清理: %s\n\n", strings.Join(words, ", ")))
	}

	if len(logs) > 0 {
		sb.WriteString(fmt.Sprintf("📋 操作记录: %d 条\n", len(logs)))
		for _, l := range logs {
			sb.WriteString(fmt.Sprintf("   [%s] %s\n", l.Type, l.Summary))
		}
	}

	// If Gemini is available, generate a summary
	if geminiKey != "" && (len(todayTraces) > 0 || len(todayCleaned) > 0) {
		prompt := fmt.Sprintf("你是一名英语学习助手。以下是用户今天的学习数据，请用中文写一段简短鼓励性的总结和明日建议(100字以内):\n\n%s", sb.String())
		if summary, err := callGemini(geminiKey, geminiModel, prompt); err == nil {
			sb.WriteString("\n\n🤖 AI 点评:\n" + summary)
		}
	}

	return sb.String(), nil
}

// POST /email/send → send today's daily report via Gmail
func emailSendHandler(geminiKey, geminiModel string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			To string `json:"to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.To == "" {
			http.Error(w, "need {\"to\":\"email@example.com\"}", http.StatusBadRequest)
			return
		}

		cfg, err := loadGmailOAuth2Config()
		if err != nil {
			http.Error(w, "OAuth config: "+err.Error(), http.StatusInternalServerError)
			return
		}
		tok, err := loadSavedToken()
		if err != nil {
			http.Error(w, "未授权 Gmail，请先访问 /gmail/auth", http.StatusUnauthorized)
			return
		}

		// Refresh token if needed
		tokenSource := cfg.TokenSource(context.Background(), tok)
		newTok, err := tokenSource.Token()
		if err != nil {
			http.Error(w, "token refresh failed: "+err.Error(), http.StatusUnauthorized)
			return
		}
		if newTok.AccessToken != tok.AccessToken {
			saveToken(newTok)
		}

		report, err := buildDailyReport(geminiKey, geminiModel)
		if err != nil {
			http.Error(w, "build report: "+err.Error(), http.StatusInternalServerError)
			return
		}

		loc := time.FixedZone("UTC+8", 8*60*60)
		today := time.Now().In(loc).Format("2006-01-02")
		subject := fmt.Sprintf("📚 英语学习日报 — %s", today)

		// Build RFC 2822 email
		msgStr := fmt.Sprintf("To: %s\r\nSubject: =?utf-8?B?%s?=\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\n%s",
			req.To,
			base64.StdEncoding.EncodeToString([]byte(subject)),
			report,
		)
		raw := base64.URLEncoding.EncodeToString([]byte(msgStr))

		// Send via Gmail API
		sendURL := "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
		body, _ := json.Marshal(map[string]string{"raw": raw})
		httpReq, _ := http.NewRequest("POST", sendURL, bytes.NewReader(body))
		httpReq.Header.Set("Authorization", "Bearer "+newTok.AccessToken)
		httpReq.Header.Set("Content-Type", "application/json")

		gmailClient := &http.Client{Timeout: 30 * time.Second}
		resp, err := gmailClient.Do(httpReq)
		if err != nil {
			http.Error(w, "send failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		respBody, _ := io.ReadAll(resp.Body)

		if resp.StatusCode != 200 {
			http.Error(w, "Gmail API error: "+string(respBody), resp.StatusCode)
			return
		}

		appendActivityLog("email", fmt.Sprintf("已发送日报到 %s", req.To), nil)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "sent", "to": req.To})
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------


func main() {
	// Resolve project root (works from cmd/translate_server/ or project root)
	// Try ../../ first (running from cmd/translate_server/), then current dir
	if _, err := os.Stat("../../.env"); err == nil {
		projectRoot, _ = filepath.Abs("../../")
	} else if _, err := os.Stat(".env"); err == nil {
		projectRoot, _ = filepath.Abs(".")
	} else {
		// fallback: absolute path
		home, _ := os.UserHomeDir()
		projectRoot = filepath.Join(home, "GolandProjects", "lexica")
	}

	// Load .env
	loadEnv(filepath.Join(projectRoot, ".env"))

	translateKey := os.Getenv("GOOGLE_TRANSLATE_API_KEY")
	if translateKey == "" {
		translateKey = os.Getenv("GOOGLE_TTS_API_KEY")
	}
	if translateKey == "" {
		log.Fatal("Set GOOGLE_TRANSLATE_API_KEY in .env")
	}

	ttsKey := os.Getenv("GOOGLE_TTS_API_KEY")
	if ttsKey == "" {
		log.Fatal("Set GOOGLE_TTS_API_KEY in .env")
	}

	geminiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	geminiModel := strings.TrimSpace(os.Getenv("GEMINI_MODEL"))
	if geminiModel == "" {
		geminiModel = defaultGeminiModel
	}
	if geminiKey == "" {
		log.Println("[warn] GEMINI_API_KEY not set – /trace/ask will return an error")
	} else {
		log.Printf("[init] Gemini model: %s", geminiModel)
	}

	// GCS configuration
	gcsBucket := os.Getenv("GCS_BUCKET")
	if gcsBucket == "" {
		gcsBucket = "cloud-storage-jtz"
	}
	gcsPrefix := os.Getenv("GCS_PREFIX")
	if gcsPrefix == "" {
		gcsPrefix = "study-english/"
	}

	credPath := resolveCredentials()
	if credPath == "" {
		log.Println("[warn] No GCS credentials found – /gcs/* endpoints will fail")
	} else {
		log.Printf("[init] GCS credentials: %s", credPath)
	}

	// Load disk caches
	loadTranslateCache()
	loadTTSCache()
	purgeOldActivityLogs()
	log.Printf("[init] project root: %s", projectRoot)

	// Store bucket name globally for syncToCloud
	gcsBucketName = gcsBucket

	// Initialize global GCS client for cloud sync
	if credPath != "" {
		gcsCtx := context.Background()
		var gcsErr error
		gcsClientGlobal, gcsErr = storage.NewClient(gcsCtx, option.WithCredentialsFile(credPath))
		if gcsErr != nil {
			log.Printf("[warn] global GCS client init failed: %v", gcsErr)
		} else {
			log.Println("[init] global GCS client ready for TTS sync")
		}
	}

	// Initialize Firestore client
	if credPath != "" {
		fsCtx := context.Background()
		fsClient, fsErr := firestore.NewClientWithDatabase(fsCtx, "vertex-jtz", "firestore-test", option.WithCredentialsFile(credPath))
		if fsErr != nil {
			log.Printf("[warn] Firestore init failed: %v – running in local-only mode", fsErr)
		} else {
			firestoreClient = fsClient
			log.Println("[init] Firestore connected: vertex-jtz/firestore-test")
		}
	}

	// Run one-time migration in background
	go migrateExistingTTSToCloud()

	http.HandleFunc("/", translateHandler(translateKey, ttsKey))
	http.HandleFunc("/play", playHandler(ttsKey))
	http.HandleFunc("/save", saveHandler())
	http.HandleFunc("/lexica", lexicaHandler())
	http.HandleFunc("/lexica.css", lexicaAssetHandler("lexica.css", "text/css; charset=utf-8"))
	http.HandleFunc("/lexica.js", lexicaAssetHandler("lexica.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/gcs/list", gcsListHandler(gcsBucket, gcsPrefix, credPath))
	http.HandleFunc("/gcs/download", gcsDownloadHandler(gcsBucket, gcsPrefix, credPath))
	http.HandleFunc("/dictation/days", dictationDaysHandler(gcsBucket, credPath))
	http.HandleFunc("/dictation/words", dictationWordsHandler(gcsBucket, credPath))
	http.HandleFunc("/dictation/tts", dictationTTSHandler(ttsKey))
	http.HandleFunc("/trace/record", traceRecordHandler())
	http.HandleFunc("/trace/list", traceListHandler())
	http.HandleFunc("/trace/delete", traceDeleteHandler())
	http.HandleFunc("/trace/ask", traceAskHandler(geminiKey, geminiModel))
	http.HandleFunc("/clean", cleanHandler())
	http.HandleFunc("/clean/sync", cleanSyncHandler(gcsBucket, credPath))
	http.HandleFunc("/activity/list", activityLogListHandler())
	http.HandleFunc("/gmail/auth", gmailAuthHandler())
	http.HandleFunc("/gmail/callback", gmailCallbackHandler())
	http.HandleFunc("/gmail/status", gmailStatusHandler())
	http.HandleFunc("/email/send", emailSendHandler(geminiKey, geminiModel))

	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	fmt.Printf("Listening on http://%s\n", addr)
	fmt.Printf("  Lexica reader: http://%s/lexica\n", addr)
	fmt.Printf("  Dictation:     http://%s/lexica (toggle button)\n", addr)
	fmt.Printf("  GCS bucket: %s (prefix: %s)\n", gcsBucket, gcsPrefix)
	log.Fatal(http.ListenAndServe(addr, nil))
}

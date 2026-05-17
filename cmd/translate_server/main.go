package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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

	return mp3Path
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
		projectRoot = filepath.Join(home, "GolandProjects", "my-toolbox")
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

	// Load disk caches
	loadTranslateCache()
	loadTTSCache()
	log.Printf("[init] project root: %s", projectRoot)

	http.HandleFunc("/", translateHandler(translateKey, ttsKey))
	http.HandleFunc("/play", playHandler(ttsKey))
	http.HandleFunc("/save", saveHandler())

	addr := "127.0.0.1:8080"
	fmt.Printf("Listening on http://%s\n", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

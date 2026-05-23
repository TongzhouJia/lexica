package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"cloud.google.com/go/firestore"
	"cloud.google.com/go/storage"
	"google.golang.org/api/iterator"
)

// ---------------------------------------------------------------------------
// Dictation endpoints (Firestore-backed)
// ---------------------------------------------------------------------------

const (
	dictationCollection = "dictation_days"
	gcsDailyWordPrefix  = "study-english/vocabulary-list/daily_english_word/"
)

// DictationWord is a single word entry returned to the frontend
type DictationWord struct {
	English string `json:"english"`
	Chinese string `json:"chinese"`
}

// parseWordsText parses a daily_english_word .txt into DictationWord entries.
func parseWordsText(text string) []DictationWord {
	var words []DictationWord
	for _, line := range strings.Split(text, "\n") {
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
	return words
}

// dictWordsToFirestoreSlice converts to a slice acceptable by Firestore.
func dictWordsToFirestoreSlice(words []DictationWord) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(words))
	for _, w := range words {
		out = append(out, map[string]interface{}{
			"english": w.English,
			"chinese": w.Chinese,
		})
	}
	return out
}

// firestoreDocToWords decodes a Firestore dictation_days doc into DictationWord slice.
func firestoreDocToWords(doc map[string]interface{}) []DictationWord {
	raw, ok := doc["words"].([]interface{})
	if !ok {
		return nil
	}
	var words []DictationWord
	for _, item := range raw {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		eng, _ := m["english"].(string)
		zh, _ := m["chinese"].(string)
		if eng == "" {
			continue
		}
		words = append(words, DictationWord{English: eng, Chinese: zh})
	}
	return words
}

// importDailyWordsFromGCS runs once at startup: copies any daily_english_word/*.txt
// from GCS into Firestore (only if the corresponding doc is missing).
func importDailyWordsFromGCS(bucketName, credPath string) {
	if firestoreClient == nil {
		log.Println("[dict import] skipped – Firestore not initialized")
		return
	}
	if bucketName == "" || credPath == "" {
		log.Println("[dict import] skipped – GCS bucket/credentials not configured")
		return
	}

	ctx := context.Background()
	client, err := newGCSClient(ctx, credPath)
	if err != nil {
		log.Printf("[dict import] GCS client error: %v", err)
		return
	}
	defer client.Close()

	imported, skipped, failed := 0, 0, 0
	it := client.Bucket(bucketName).Objects(ctx, &storage.Query{Prefix: gcsDailyWordPrefix})
	for {
		attrs, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			log.Printf("[dict import] iterator error: %v", err)
			return
		}
		name := strings.TrimPrefix(attrs.Name, gcsDailyWordPrefix)
		if !strings.HasSuffix(name, ".txt") || strings.Contains(name, "/") {
			continue
		}
		day := strings.TrimSuffix(name, ".txt")

		docRef := firestoreClient.Collection(dictationCollection).Doc(day)
		if snap, err := docRef.Get(ctx); err == nil && snap.Exists() {
			skipped++
			continue
		}

		reader, err := client.Bucket(bucketName).Object(attrs.Name).NewReader(ctx)
		if err != nil {
			log.Printf("[dict import] read %s error: %v", attrs.Name, err)
			failed++
			continue
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			failed++
			continue
		}

		words := parseWordsText(string(data))
		if _, err := docRef.Set(ctx, map[string]interface{}{
			"day":       day,
			"words":     dictWordsToFirestoreSlice(words),
			"updatedAt": firestore.ServerTimestamp,
		}); err != nil {
			log.Printf("[dict import] Firestore write %s error: %v", day, err)
			failed++
			continue
		}
		imported++
	}
	if imported+skipped+failed > 0 {
		log.Printf("[dict import] done: %d imported, %d skipped, %d failed", imported, skipped, failed)
	}
}

// dictationDaysHandler – GET /dictation/days → JSON list of available day names
func dictationDaysHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if firestoreClient == nil {
			http.Error(w, "Firestore not configured", http.StatusInternalServerError)
			return
		}

		ctx := r.Context()
		iter := firestoreClient.Collection(dictationCollection).Documents(ctx)
		defer iter.Stop()

		var days []string
		for {
			snap, err := iter.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				log.Printf("[dictation/days] iterator error: %v", err)
				http.Error(w, "Firestore error", http.StatusInternalServerError)
				return
			}
			days = append(days, snap.Ref.ID)
		}
		sort.Strings(days)

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(days)
	}
}

// dictationWordsHandler – GET /dictation/words?day=XX → JSON word list
func dictationWordsHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if firestoreClient == nil {
			http.Error(w, "Firestore not configured", http.StatusInternalServerError)
			return
		}

		day := r.URL.Query().Get("day")
		if day == "" {
			http.Error(w, "missing day parameter", http.StatusBadRequest)
			return
		}

		ctx := r.Context()
		snap, err := firestoreClient.Collection(dictationCollection).Doc(day).Get(ctx)
		if err != nil {
			log.Printf("[dictation/words] read %s error: %v", day, err)
			http.Error(w, "day not found: "+day, http.StatusNotFound)
			return
		}

		words := firestoreDocToWords(snap.Data())
		log.Printf("[dictation] loaded %d words from %s", len(words), day)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(words)
	}
}

// dictationUpdateWordHandler – POST /dictation/update-word
// body: {day, english, chinese}
// Updates the chinese translation of a single word in Firestore
// and also rewrites the local LingoCleaner .txt file if found.
func dictationUpdateWordHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "only POST is allowed", http.StatusMethodNotAllowed)
			return
		}
		if firestoreClient == nil {
			http.Error(w, "Firestore not configured", http.StatusInternalServerError)
			return
		}

		var req struct {
			Day     string `json:"day"`
			English string `json:"english"`
			Chinese string `json:"chinese"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		req.Day = strings.TrimSpace(req.Day)
		req.English = strings.TrimSpace(req.English)
		req.Chinese = strings.TrimSpace(req.Chinese)
		if req.Day == "" || req.English == "" {
			http.Error(w, "missing day or english", http.StatusBadRequest)
			return
		}

		ctx := r.Context()
		docRef := firestoreClient.Collection(dictationCollection).Doc(req.Day)
		snap, err := docRef.Get(ctx)
		if err != nil {
			http.Error(w, "day not found: "+req.Day, http.StatusNotFound)
			return
		}

		words := firestoreDocToWords(snap.Data())
		updated := false
		for i := range words {
			if strings.EqualFold(words[i].English, req.English) {
				words[i].Chinese = req.Chinese
				updated = true
				break
			}
		}
		if !updated {
			http.Error(w, "word not found: "+req.English, http.StatusNotFound)
			return
		}

		if _, err := docRef.Set(ctx, map[string]interface{}{
			"day":       req.Day,
			"words":     dictWordsToFirestoreSlice(words),
			"updatedAt": firestore.ServerTimestamp,
		}); err != nil {
			log.Printf("[dictation/update-word] Firestore write error: %v", err)
			http.Error(w, "write error", http.StatusInternalServerError)
			return
		}

		// Best-effort local .txt rewrite (LingoCleaner source)
		localPath := filepath.Join(lingoBaseDir, "daily_english_word", req.Day+".txt")
		if data, err := os.ReadFile(localPath); err == nil {
			lines := strings.Split(string(data), "\n")
			for i, line := range lines {
				fields := strings.Fields(line)
				if len(fields) >= 1 && strings.EqualFold(fields[0], req.English) {
					lines[i] = req.English + " " + req.Chinese
					break
				}
			}
			os.WriteFile(localPath, []byte(strings.Join(lines, "\n")), 0644)
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]any{"status": "success"})
	}
}

// dictationLoadCSVHandler – POST /dictation/load-csv
// body: {path}
// Reads a CSV from the local filesystem and returns its rows as DictationWord list.
// Expected format (the same one /dictation download produces):
//
//	English,Chinese
//	"hello","你好"
//	"world","世界"
func dictationLoadCSVHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "only POST is allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		path := strings.TrimSpace(req.Path)
		if path == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		// Allow ~ expansion for convenience
		if strings.HasPrefix(path, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				path = filepath.Join(home, path[2:])
			}
		}
		if !strings.EqualFold(filepath.Ext(path), ".csv") {
			http.Error(w, "only .csv files are supported", http.StatusBadRequest)
			return
		}

		data, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "read error: "+err.Error(), http.StatusNotFound)
			return
		}
		if bytes.HasPrefix(data, []byte("\xEF\xBB\xBF")) {
			data = data[3:]
		}

		reader := csv.NewReader(bytes.NewReader(data))
		reader.FieldsPerRecord = -1
		rows, err := reader.ReadAll()
		if err != nil {
			http.Error(w, "csv parse error: "+err.Error(), http.StatusBadRequest)
			return
		}

		var words []DictationWord
		for i, row := range rows {
			if len(row) < 2 {
				continue
			}
			if i == 0 && strings.EqualFold(strings.TrimSpace(row[0]), "English") {
				continue
			}
			eng := strings.TrimSpace(row[0])
			zh := strings.TrimSpace(row[1])
			if eng == "" {
				continue
			}
			words = append(words, DictationWord{English: eng, Chinese: zh})
		}

		log.Printf("[dictation/load-csv] loaded %d words from %s", len(words), path)
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

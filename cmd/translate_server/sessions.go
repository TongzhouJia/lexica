package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Session History (dictation / recognition results, last 10 kept)
// ---------------------------------------------------------------------------

const maxSessions = 10

type SessionRecord struct {
	ID        string          `json:"id"`
	Timestamp string          `json:"timestamp"`
	Mode      string          `json:"mode"` // dictation_strict, dictation_skip, recognition
	DayName   string          `json:"dayName"`
	GoodLabel string          `json:"goodLabel"` // e.g. "正确" or "认识"
	BadLabel  string          `json:"badLabel"`  // e.g. "错误" or "不认识"
	GoodWords []DictationWord `json:"goodWords"`
	BadWords  []DictationWord `json:"badWords"`
}

func sessionsDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "sessions")
}

func listSessionFilesNewestFirst() ([]os.DirEntry, error) {
	entries, err := os.ReadDir(sessionsDir())
	if err != nil {
		return nil, err
	}
	var jsons []os.DirEntry
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			jsons = append(jsons, e)
		}
	}
	sort.Slice(jsons, func(i, j int) bool { return jsons[i].Name() > jsons[j].Name() })
	return jsons, nil
}

func pruneSessions() {
	jsons, err := listSessionFilesNewestFirst()
	if err != nil {
		return
	}
	for i := maxSessions; i < len(jsons); i++ {
		os.Remove(filepath.Join(sessionsDir(), jsons[i].Name()))
	}
}

// sessionRecordHandler – POST /session/record  (body: SessionRecord)
func sessionRecordHandler() http.HandlerFunc {
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
		var rec SessionRecord
		if err := json.NewDecoder(r.Body).Decode(&rec); err != nil {
			http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if len(rec.GoodWords) == 0 && len(rec.BadWords) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"status": "skipped"})
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
		if err := os.MkdirAll(sessionsDir(), 0755); err != nil {
			http.Error(w, "mkdir failed", http.StatusInternalServerError)
			return
		}
		path := filepath.Join(sessionsDir(), rec.ID+".json")
		data, err := json.MarshalIndent(rec, "", "  ")
		if err != nil {
			http.Error(w, "marshal failed", http.StatusInternalServerError)
			return
		}
		if err := os.WriteFile(path, data, 0644); err != nil {
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		pruneSessions()
		log.Printf("[session saved] %s %s good=%d bad=%d", rec.Mode, rec.DayName, len(rec.GoodWords), len(rec.BadWords))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": rec.ID})
	}
}

type sessionListItem struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Mode      string `json:"mode"`
	DayName   string `json:"dayName"`
	GoodLabel string `json:"goodLabel"`
	BadLabel  string `json:"badLabel"`
	GoodCount int    `json:"goodCount"`
	BadCount  int    `json:"badCount"`
}

// sessionListHandler – GET /session/list → up to 10 newest sessions
func sessionListHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		jsons, err := listSessionFilesNewestFirst()
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]sessionListItem{})
			return
		}
		items := make([]sessionListItem, 0, len(jsons))
		for i, e := range jsons {
			if i >= maxSessions {
				break
			}
			data, err := os.ReadFile(filepath.Join(sessionsDir(), e.Name()))
			if err != nil {
				continue
			}
			var rec SessionRecord
			if err := json.Unmarshal(data, &rec); err != nil {
				continue
			}
			items = append(items, sessionListItem{
				ID:        rec.ID,
				Timestamp: rec.Timestamp,
				Mode:      rec.Mode,
				DayName:   rec.DayName,
				GoodLabel: rec.GoodLabel,
				BadLabel:  rec.BadLabel,
				GoodCount: len(rec.GoodWords),
				BadCount:  len(rec.BadWords),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(items)
	}
}

// sessionCSVHandler – GET /session/csv?id=X&kind=good|bad
func sessionCSVHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		id := r.URL.Query().Get("id")
		kind := r.URL.Query().Get("kind")
		if id == "" || (kind != "good" && kind != "bad") {
			http.Error(w, "missing id or kind", http.StatusBadRequest)
			return
		}
		// Prevent path traversal
		if strings.ContainsAny(id, "/\\.") {
			http.Error(w, "invalid id", http.StatusBadRequest)
			return
		}
		data, err := os.ReadFile(filepath.Join(sessionsDir(), id+".json"))
		if err != nil {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		var rec SessionRecord
		if err := json.Unmarshal(data, &rec); err != nil {
			http.Error(w, "session parse error", http.StatusInternalServerError)
			return
		}
		words := rec.GoodWords
		suffix := "good"
		if kind == "bad" {
			words = rec.BadWords
			suffix = "bad"
		}
		var buf bytes.Buffer
		buf.WriteString("\xef\xbb\xbf")
		cw := csv.NewWriter(&buf)
		cw.Write([]string{"English", "Chinese"})
		for _, word := range words {
			cw.Write([]string{word.English, word.Chinese})
		}
		cw.Flush()

		fileName := fmt.Sprintf("%s_%s.csv", strings.ReplaceAll(rec.DayName, " ", "_"), suffix)
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
		w.Write(buf.Bytes())
	}
}

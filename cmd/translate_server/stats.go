package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Daily counters (TTS plays, dictation inputs, dictation words, recognition words)
//
// One JSON file per UTC+8 day:
//   data/translate_server/stats/YYYY-MM-DD.json
// ---------------------------------------------------------------------------

type DailyStats struct {
	Date       string `json:"date"`
	TTSPlays   int    `json:"ttsPlays"`
	DictInputs int    `json:"dictInputs"`
	DictWords  int    `json:"dictWords"`
	RecogWords int    `json:"recogWords"`
}

var statsMu sync.Mutex

func statsDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "stats")
}

func statsPath(date string) string {
	return filepath.Join(statsDir(), date+".json")
}

func loadStats(date string) DailyStats {
	s := DailyStats{Date: date}
	if data, err := os.ReadFile(statsPath(date)); err == nil {
		json.Unmarshal(data, &s)
	}
	if s.Date == "" {
		s.Date = date
	}
	return s
}

func saveStats(s DailyStats) error {
	if err := os.MkdirAll(statsDir(), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(statsPath(s.Date), data, 0644)
}

// countCleanedWordsToday scans clean_sync_pending.json for records cleaned
// on the given UTC+8 date and sums up how many comma-separated words were
// removed.
func countCleanedWordsToday(date string) int {
	pendingFile := filepath.Join(projectRoot, "data", "clean_sync_pending.json")
	data, err := os.ReadFile(pendingFile)
	if err != nil {
		return 0
	}
	var records []CleanSyncRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return 0
	}
	count := 0
	for _, rec := range records {
		if !strings.HasPrefix(rec.CleanedAt, date) {
			continue
		}
		for _, w := range strings.Split(rec.Words, ",") {
			if strings.TrimSpace(w) != "" {
				count++
			}
		}
	}
	return count
}

// statsIncHandler – POST /stats/inc {type, count?}
// Bumps a counter for today (UTC+8). type ∈ tts_play | dict_input |
// dict_word | recog_word.
func statsIncHandler() http.HandlerFunc {
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

		var req struct {
			Type  string `json:"type"`
			Count int    `json:"count"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if req.Count <= 0 {
			req.Count = 1
		}

		statsMu.Lock()
		defer statsMu.Unlock()

		date := utc8Date(time.Now())
		s := loadStats(date)
		switch req.Type {
		case "tts_play":
			s.TTSPlays += req.Count
		case "dict_input":
			s.DictInputs += req.Count
		case "dict_word":
			s.DictWords += req.Count
		case "recog_word":
			s.RecogWords += req.Count
		default:
			http.Error(w, "unknown type: "+req.Type, http.StatusBadRequest)
			return
		}
		if err := saveStats(s); err != nil {
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// statsTodayHandler – GET /stats/today
// Bundled response: study time + segments + all counters + cleaned-word total.
func statsTodayHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		date := utc8Date(time.Now())
		s := loadStats(date)
		sd := loadStudyDay(date)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"date":          date,
			"studyTimeMs":   totalStudyMs(sd),
			"studySegments": sd.Segments,
			"ttsPlays":      s.TTSPlays,
			"dictInputs":    s.DictInputs,
			"dictWords":     s.DictWords,
			"recogWords":    s.RecogWords,
			"cleanedWords":  countCleanedWordsToday(date),
		})
	}
}

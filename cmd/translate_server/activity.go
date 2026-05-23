package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

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

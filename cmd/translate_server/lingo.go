package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
)

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

		var cleanedWords []string
		for _, w := range words {
			w = strings.TrimSpace(w)
			if w != "" {
				cleanedWords = append(cleanedWords, w)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":       "success",
			"cleaned":      len(cleanedWords),
			"pending_sync": len(changedFiles),
		})
	}
}

func cleanSyncHandler() http.HandlerFunc {
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

		if firestoreClient == nil {
			http.Error(w, "Firestore not configured", http.StatusInternalServerError)
			return
		}

		ctx := r.Context()
		loc := time.FixedZone("UTC+8", 8*60*60)
		synced := 0
		for i := range records {
			if records[i].SyncedAt != "" {
				continue
			}
			data, err := os.ReadFile(records[i].LocalPath)
			if err != nil {
				continue
			}
			day := strings.TrimSuffix(records[i].FileName, ".txt")
			words := parseWordsText(string(data))
			if _, err := firestoreClient.Collection(dictationCollection).Doc(day).Set(ctx, map[string]interface{}{
				"day":       day,
				"words":     dictWordsToFirestoreSlice(words),
				"updatedAt": firestore.ServerTimestamp,
			}); err != nil {
				log.Printf("[clean/sync] Firestore write %s error: %v", day, err)
				continue
			}
			records[i].SyncedAt = time.Now().In(loc).Format(time.RFC3339)
			synced++
		}

		if data, err := json.MarshalIndent(records, "", "  "); err == nil {
			os.WriteFile(pendingFile, data, 0644)
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

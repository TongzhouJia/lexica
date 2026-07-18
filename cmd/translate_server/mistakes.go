package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The 错题本 (mistake book) is stored separately from vocabulary.csv: one CSV
// file per day under data/mistakes/, named by date (YYYY-MM-DD.csv). Each row is
// english,chinese.

var mistakesMu sync.Mutex

// csvQuote wraps a field in double quotes, escaping any embedded quote by
// doubling it (RFC 4180), so every field is written as "..." unconditionally.
func csvQuote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func mistakesDir() string {
	return filepath.Join(projectRoot, "data", "mistakes")
}

func mistakesPathForDate(day string) string {
	return filepath.Join(mistakesDir(), day+".csv")
}

// mistakesContainsLocked reports whether the english term already exists in the
// given day's file. Caller must hold mistakesMu.
func mistakesContainsLocked(path, en string) (bool, error) {
	key := vocabularyKey(en)
	if key == "" {
		return false, nil
	}

	f, err := os.Open(path)
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

// mistakeSaveHandler – GET/POST /mistakes/save?text=X&translated=Y&sl=Z
// Appends english,chinese to today's data/mistakes/YYYY-MM-DD.csv if not already
// present. Responds "ok" or "exists".
func mistakeSaveHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
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

		if err := os.MkdirAll(mistakesDir(), 0755); err != nil {
			log.Printf("[mistakes error] %v", err)
			http.Error(w, "failed to create mistakes directory", http.StatusInternalServerError)
			return
		}

		day := time.Now().Format("2006-01-02")
		path := mistakesPathForDate(day)

		mistakesMu.Lock()
		defer mistakesMu.Unlock()

		exists, err := mistakesContainsLocked(path, en)
		if err != nil {
			log.Printf("[mistakes error] %v", err)
			http.Error(w, "failed to read mistakes", http.StatusInternalServerError)
			return
		}
		if exists {
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, "exists")
			return
		}

		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			log.Printf("[mistakes error] %v", err)
			http.Error(w, "failed to open file", http.StatusInternalServerError)
			return
		}
		defer f.Close()

		// Always quote both fields → "word","单词"
		line := fmt.Sprintf("%s,%s\n", csvQuote(en), csvQuote(zh))
		if _, err := f.WriteString(line); err != nil {
			log.Printf("[mistakes error] %v", err)
			http.Error(w, "failed to write csv", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	}
}

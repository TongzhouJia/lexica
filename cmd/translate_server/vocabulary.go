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
)

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

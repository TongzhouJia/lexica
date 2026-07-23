package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Japanese 例句 (example-sentence) study source.
//
// Unlike the 分卷 / 五十音 / 优先级 sources, which drill single words, this one
// studies whole sentences: each row is a 日文例句 with its 假名 reading and 中文
// translation. It reuses the JapaneseWord wire shape (english=日文例句, kana=假名,
// chinese=中文) so the existing 新词 / 学词 frontend renders it unchanged, and
// since the rows ship without local mp3s the frontend falls back to ja-JP TTS
// (see ttsLangFor / dictationTTSHandler's ?lang=).
//
// Source CSVs live in data/japanese/sentences/*.csv with columns:
//   序号, 日文例句, 假名, 中文, 覆盖的专业词, 场景
// Only 日文例句 / 假名 / 中文 are shown; the last two columns are ignored.
// ---------------------------------------------------------------------------

var (
	japaneseSentenceOnce sync.Once
	japaneseSentenceMu   sync.RWMutex
	// set id (CSV file name) -> words, in file order
	japaneseSentenceSets map[string][]JapaneseWord
	// ordered set ids so the UI shows them consistently
	japaneseSentenceOrder []string
)

func japaneseSentenceDir() string {
	return filepath.Join(japaneseDataDir(), "sentences")
}

// parseJapaneseSentenceFile reads one 例句 CSV, mapping the first three data
// columns to english/kana/chinese and dropping any extra columns (覆盖的专业词,
// 场景). audio is left empty so playback goes through TTS.
func parseJapaneseSentenceFile(path string) ([]JapaneseWord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF")) // strip UTF-8 BOM

	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}

	setID := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	var words []JapaneseWord
	for i, row := range rows {
		if i == 0 {
			continue // header row
		}
		// Columns: 序号, 日文例句, 假名, 中文, [覆盖的专业词, 场景]
		if len(row) < 4 {
			continue
		}
		sentence := strings.TrimSpace(row[1])
		kana := strings.TrimSpace(row[2])
		chinese := strings.TrimSpace(row[3])
		if sentence == "" {
			continue
		}
		words = append(words, JapaneseWord{
			English:  sentence,
			Chinese:  chinese,
			Kana:     kana,
			Audio:    "", // no local mp3 — playback uses ja-JP TTS
			Category: setID,
		})
	}
	return words, nil
}

func loadJapaneseSentences() {
	sets := make(map[string][]JapaneseWord)
	var order []string
	total := 0

	entries, err := os.ReadDir(japaneseSentenceDir())
	if err != nil {
		log.Printf("[japanese sentences] no sentences dir: %v", err)
	} else {
		var names []string
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".csv") {
				continue
			}
			names = append(names, e.Name())
		}
		sort.Strings(names)
		for _, name := range names {
			words, err := parseJapaneseSentenceFile(filepath.Join(japaneseSentenceDir(), name))
			if err != nil {
				log.Printf("[japanese sentences] parse %s error: %v", name, err)
				continue
			}
			if len(words) == 0 {
				continue
			}
			id := strings.TrimSuffix(name, filepath.Ext(name))
			sets[id] = words
			order = append(order, id)
			total += len(words)
		}
	}

	japaneseSentenceMu.Lock()
	japaneseSentenceSets = sets
	japaneseSentenceOrder = order
	japaneseSentenceMu.Unlock()

	log.Printf("[japanese sentences] loaded %d sentences across %d sets", total, len(sets))
}

func ensureJapaneseSentencesLoaded() {
	japaneseSentenceOnce.Do(loadJapaneseSentences)
}

// japaneseSentenceSetInfo is returned by /japanese/sentence-sets
type japaneseSentenceSetInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

// japaneseSentenceSetsHandler – GET /japanese/sentence-sets → [{id,label,count}]
func japaneseSentenceSetsHandler() http.HandlerFunc {
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

		ensureJapaneseSentencesLoaded()

		japaneseSentenceMu.RLock()
		out := make([]japaneseSentenceSetInfo, 0, len(japaneseSentenceOrder))
		for _, id := range japaneseSentenceOrder {
			out = append(out, japaneseSentenceSetInfo{ID: id, Label: id, Count: len(japaneseSentenceSets[id])})
		}
		japaneseSentenceMu.RUnlock()

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(out)
	}
}

// japaneseSentenceWordsHandler – GET /japanese/sentence-words[?set=X] → words
// Without ?set= returns every sentence across all sets, in set then file order.
func japaneseSentenceWordsHandler() http.HandlerFunc {
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

		ensureJapaneseSentencesLoaded()

		set := r.URL.Query().Get("set")

		japaneseSentenceMu.RLock()
		var words []JapaneseWord
		if set != "" {
			words = japaneseSentenceSets[set]
		} else {
			for _, id := range japaneseSentenceOrder {
				words = append(words, japaneseSentenceSets[id]...)
			}
		}
		japaneseSentenceMu.RUnlock()

		if words == nil {
			words = []JapaneseWord{}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(words)
	}
}

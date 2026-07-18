package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Japanese vocabulary (新标日) — loaded once from local CSVs shipped under
// data/japanese/csv/, audio played from local mp3s under data/japanese/audio/.
// Unlike the English dictation module this has no Firestore-backed per-word
// history; it's a static, local wordlist reader.
// ---------------------------------------------------------------------------

// JapaneseWord mirrors DictationWord's wire shape (english/chinese) so the
// existing dict/learn/recog/study frontend code works unchanged, plus two
// Japanese-only fields.
type JapaneseWord struct {
	English  string `json:"english"`  // 日文形式：汉字词写汉字，纯假名词写假名
	Chinese  string `json:"chinese"`  // 中文释义
	Kana     string `json:"kana"`     // 假名读音（纯假名词时与 english 相同）
	Audio    string `json:"audio"`    // 本地音频文件名（相对 data/japanese/audio/）
	Category string `json:"category"` // 分类 id
}

type japaneseCategory struct {
	ID    string // query-string identifier, also used as display label
	Label string
	Dir   string // relative dir under data/japanese/csv/
	Kanji bool   // true = 4 列 (日文(汉字),假名读音,中文释义,音频文件); false = 3 列 (日文,中文释义,音频文件)
}

var japaneseCategories = []japaneseCategory{
	{ID: "1_全汉字词", Label: "全汉字词", Dir: "1_全汉字词", Kanji: true},
	{ID: "4_平假名汉字混合词", Label: "假名汉字混合词", Dir: "4_平假名汉字混合词", Kanji: true},
	{ID: "2_全平假名词", Label: "全平假名词", Dir: filepath.Join("全假名", "2_全平假名词"), Kanji: false},
	{ID: "3_全片假名词", Label: "全片假名词", Dir: filepath.Join("全假名", "3_全片假名词"), Kanji: false},
}

// japanesePart is one CSV file within a category (like an English "day"), so
// the frontend can drill: category → part → range → study.
type japanesePart struct {
	Name  string         // CSV file name, e.g. "1_全汉字词_part1.csv"
	Label string         // display label, e.g. "1" (the partN number)
	Words []JapaneseWord // words in this file, in file order
}

var (
	japaneseOnce  sync.Once
	japaneseMu    sync.RWMutex
	japaneseWords map[string][]JapaneseWord // category id -> all words, load order preserved
	japaneseParts map[string][]japanesePart // category id -> parts (CSV files), sorted naturally
	japaneseKana  map[string][]japanesePart // category id -> gojūon groups (只有汉字/混合词), in kana order
)

func japaneseDataDir() string {
	return filepath.Join(projectRoot, "data", "japanese")
}

func japaneseCSVDir() string {
	return filepath.Join(japaneseDataDir(), "csv")
}

func japaneseAudioDir() string {
	return filepath.Join(japaneseDataDir(), "audio")
}

// japaneseKanaDir is the gojūon-sorted copy built by scripts/build_kana.py:
// data/japanese/kana/<category>/<kana>/<kana>.csv.
func japaneseKanaDir() string {
	return filepath.Join(japaneseDataDir(), "kana")
}

// loadJapaneseKanaGroups reads the gojūon folders for a category. Each subdir is
// one initial-kana group holding a single CSV. Returns nil (no error) when the
// category has no kana copy (only 汉字/混合词 categories do). Directory order
// from ReadDir is lexicographic, which for base-kana codepoints is gojūon order.
func loadJapaneseKanaGroups(cat japaneseCategory) []japanesePart {
	base := filepath.Join(japaneseKanaDir(), cat.ID)
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil // no kana copy for this category
	}

	var groups []japanesePart
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		kana := e.Name()
		gdir := filepath.Join(base, kana)
		files, err := os.ReadDir(gdir)
		if err != nil {
			continue
		}
		var words []JapaneseWord
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(strings.ToLower(f.Name()), ".csv") {
				continue
			}
			w, err := parseJapaneseCSVFile(cat, filepath.Join(gdir, f.Name()))
			if err != nil {
				log.Printf("[japanese] parse kana %s/%s error: %v", cat.ID, kana, err)
				continue
			}
			words = append(words, w...)
		}
		if len(words) > 0 {
			groups = append(groups, japanesePart{Name: kana, Label: kana, Words: words})
		}
	}
	return groups
}

// partNumberRe pulls the trailing "_partN" number out of a CSV filename so
// files sort naturally (part2 before part10) instead of lexicographically.
var partNumberRe = regexp.MustCompile(`_part(\d+)\.csv$`)

func sortCSVPartFiles(names []string) {
	num := func(name string) int {
		m := partNumberRe.FindStringSubmatch(name)
		if m == nil {
			return 0
		}
		n, _ := strconv.Atoi(m[1])
		return n
	}
	sort.Slice(names, func(i, j int) bool {
		ni, nj := num(names[i]), num(names[j])
		if ni != nj {
			return ni < nj
		}
		return names[i] < names[j]
	})
}

// parseJapaneseCSVFile parses a single CSV file into words (skipping the header
// row), honoring the category's 4-column (汉字) vs 3-column (纯假名) layout.
func parseJapaneseCSVFile(cat japaneseCategory, path string) ([]JapaneseWord, error) {
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

	var words []JapaneseWord
	for i, row := range rows {
		if i == 0 {
			continue // header row
		}
		if cat.Kanji {
			if len(row) < 4 {
				continue
			}
			word := strings.TrimSpace(row[0])
			kana := strings.TrimSpace(row[1])
			chinese := strings.TrimSpace(row[2])
			audio := strings.TrimSpace(row[3])
			if word == "" {
				continue
			}
			words = append(words, JapaneseWord{English: word, Chinese: chinese, Kana: kana, Audio: audio, Category: cat.ID})
		} else {
			if len(row) < 3 {
				continue
			}
			word := strings.TrimSpace(row[0])
			chinese := strings.TrimSpace(row[1])
			audio := strings.TrimSpace(row[2])
			if word == "" {
				continue
			}
			words = append(words, JapaneseWord{English: word, Chinese: chinese, Kana: word, Audio: audio, Category: cat.ID})
		}
	}
	return words, nil
}

// loadJapaneseCategory parses every *.csv under a category's directory, one
// japanesePart per file, sorted naturally (part2 before part10).
func loadJapaneseCategory(cat japaneseCategory) ([]japanesePart, error) {
	dir := filepath.Join(japaneseCSVDir(), cat.Dir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".csv") {
			continue
		}
		names = append(names, e.Name())
	}
	sortCSVPartFiles(names)

	var parts []japanesePart
	for _, name := range names {
		words, err := parseJapaneseCSVFile(cat, filepath.Join(dir, name))
		if err != nil {
			log.Printf("[japanese] parse %s/%s error: %v", cat.Dir, name, err)
			continue
		}
		parts = append(parts, japanesePart{Name: name, Label: japanesePartLabel(name), Words: words})
	}
	return parts, nil
}

// japanesePartLabel turns "1_全汉字词_part7.csv" into "7"; falls back to the
// file name (minus .csv) when there's no _partN suffix.
func japanesePartLabel(name string) string {
	if m := partNumberRe.FindStringSubmatch(name); m != nil {
		return m[1]
	}
	return strings.TrimSuffix(name, ".csv")
}

// loadJapaneseWords loads every category into memory. Cheap enough (a few
// thousand short rows total) to just read from disk once at startup.
func loadJapaneseWords() {
	outWords := make(map[string][]JapaneseWord, len(japaneseCategories))
	outParts := make(map[string][]japanesePart, len(japaneseCategories))
	outKana := make(map[string][]japanesePart, len(japaneseCategories))
	total := 0
	for _, cat := range japaneseCategories {
		parts, err := loadJapaneseCategory(cat)
		if err != nil {
			log.Printf("[japanese] skip category %s: %v", cat.ID, err)
			continue
		}
		var flat []JapaneseWord
		for _, p := range parts {
			flat = append(flat, p.Words...)
		}
		outWords[cat.ID] = flat
		outParts[cat.ID] = parts
		if groups := loadJapaneseKanaGroups(cat); len(groups) > 0 {
			outKana[cat.ID] = groups
		}
		total += len(flat)
	}

	japaneseMu.Lock()
	japaneseWords = outWords
	japaneseParts = outParts
	japaneseKana = outKana
	japaneseMu.Unlock()

	log.Printf("[japanese] loaded %d words across %d categories (%d with 五十音 index)", total, len(outWords), len(outKana))
}

func ensureJapaneseWordsLoaded() {
	japaneseOnce.Do(loadJapaneseWords)
}

// japaneseWordsHandler – GET /japanese/words?category=1_全汉字词 → JSON word list
func japaneseWordsHandler() http.HandlerFunc {
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

		ensureJapaneseWordsLoaded()

		category := r.URL.Query().Get("category")
		if category == "" {
			http.Error(w, "missing category parameter", http.StatusBadRequest)
			return
		}

		part := r.URL.Query().Get("part")

		japaneseMu.RLock()
		words, ok := japaneseWords[category]
		if ok && part != "" {
			// Return just the requested part (CSV file) when specified.
			found := false
			for _, p := range japaneseParts[category] {
				if p.Name == part {
					words = p.Words
					found = true
					break
				}
			}
			ok = found
		}
		japaneseMu.RUnlock()
		if !ok {
			http.Error(w, "unknown category/part", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(words)
	}
}

// japanesePartInfo is returned by /japanese/parts
type japanesePartInfo struct {
	Part  string `json:"part"`  // CSV file name, passed back as ?part=
	Label string `json:"label"` // display label, e.g. "1"
	Count int    `json:"count"`
}

// japanesePartsHandler – GET /japanese/parts?category=X → [{part,label,count}]
func japanesePartsHandler() http.HandlerFunc {
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

		ensureJapaneseWordsLoaded()

		category := r.URL.Query().Get("category")
		if category == "" {
			http.Error(w, "missing category parameter", http.StatusBadRequest)
			return
		}

		japaneseMu.RLock()
		parts, ok := japaneseParts[category]
		out := make([]japanesePartInfo, 0, len(parts))
		for _, p := range parts {
			out = append(out, japanesePartInfo{Part: p.Name, Label: p.Label, Count: len(p.Words)})
		}
		japaneseMu.RUnlock()
		if !ok {
			http.Error(w, "unknown category: "+category, http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(out)
	}
}

// japaneseCategoryInfo is returned by /japanese/categories
type japaneseCategoryInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

// japaneseCategoriesHandler – GET /japanese/categories → [{id,label,count}]
func japaneseCategoriesHandler() http.HandlerFunc {
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

		ensureJapaneseWordsLoaded()

		japaneseMu.RLock()
		out := make([]japaneseCategoryInfo, 0, len(japaneseCategories))
		for _, cat := range japaneseCategories {
			out = append(out, japaneseCategoryInfo{ID: cat.ID, Label: cat.Label, Count: len(japaneseWords[cat.ID])})
		}
		japaneseMu.RUnlock()

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(out)
	}
}

// japaneseKanaInfo is returned by /japanese/kana-letters
type japaneseKanaInfo struct {
	Kana  string `json:"kana"`  // e.g. "あ", passed back as ?kana=
	Count int    `json:"count"`
}

// japaneseKanaLettersHandler – GET /japanese/kana-letters?category=X →
// [{kana,count}] in gojūon order. Empty list for categories without a 五十音 copy.
func japaneseKanaLettersHandler() http.HandlerFunc {
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

		ensureJapaneseWordsLoaded()

		category := r.URL.Query().Get("category")
		if category == "" {
			http.Error(w, "missing category parameter", http.StatusBadRequest)
			return
		}

		japaneseMu.RLock()
		groups := japaneseKana[category]
		out := make([]japaneseKanaInfo, 0, len(groups))
		for _, g := range groups {
			out = append(out, japaneseKanaInfo{Kana: g.Name, Count: len(g.Words)})
		}
		japaneseMu.RUnlock()

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(out)
	}
}

// japaneseKanaWordsHandler – GET /japanese/kana-words?category=X&kana=あ → words
func japaneseKanaWordsHandler() http.HandlerFunc {
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

		ensureJapaneseWordsLoaded()

		category := r.URL.Query().Get("category")
		kana := r.URL.Query().Get("kana")
		if category == "" || kana == "" {
			http.Error(w, "missing category or kana", http.StatusBadRequest)
			return
		}

		japaneseMu.RLock()
		var words []JapaneseWord
		found := false
		for _, g := range japaneseKana[category] {
			if g.Name == kana {
				words = g.Words
				found = true
				break
			}
		}
		japaneseMu.RUnlock()
		if !found {
			http.Error(w, "unknown category/kana", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(words)
	}
}

// japaneseAudioHandler – GET /japanese/audio/<file>.mp3 → serves the local
// pre-recorded pronunciation clip that shipped with the CSVs.
func japaneseAudioHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "only GET is allowed", http.StatusMethodNotAllowed)
			return
		}

		name := strings.TrimPrefix(r.URL.Path, "/japanese/audio/")
		if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, "/\\") {
			http.Error(w, "invalid file name", http.StatusBadRequest)
			return
		}

		path := filepath.Join(japaneseAudioDir(), name)
		data, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "audio not found: "+name, http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Cache-Control", "public, max-age=604800")
		w.Write(data)
	}
}

// ---------------------------------------------------------------------------
// GCS backup — best-effort, one-shot at startup: uploads the local Japanese
// CSVs to the same bucket used for everything else, under study-japanese/csv/.
// Audio stays local only (it's 100+MB of mp3s and the app reads it straight
// from disk), matching the "just use the local audio folder" instruction.
// ---------------------------------------------------------------------------

const gcsJapanesePrefix = "study-japanese/csv/"

func japaneseSyncCSVToGCS(bucketName, credPath string) {
	if bucketName == "" || credPath == "" {
		log.Println("[japanese gcs sync] skipped – GCS bucket/credentials not configured")
		return
	}

	ctx := context.Background()
	client, err := newGCSClient(ctx, credPath)
	if err != nil {
		log.Printf("[japanese gcs sync] client error: %v", err)
		return
	}
	defer client.Close()

	root := japaneseCSVDir()
	uploaded, skipped, failed := 0, 0, 0

	err = filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() || !strings.HasSuffix(strings.ToLower(info.Name()), ".csv") {
			return nil
		}

		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		objectName := gcsJapanesePrefix + filepath.ToSlash(rel)
		obj := client.Bucket(bucketName).Object(objectName)

		if _, attrErr := obj.Attrs(ctx); attrErr == nil {
			skipped++
			return nil // already uploaded in a previous run
		}

		data, readErr := os.ReadFile(path)
		if readErr != nil {
			failed++
			return nil
		}

		writer := obj.NewWriter(ctx)
		writer.ContentType = "text/csv; charset=utf-8"
		if _, writeErr := writer.Write(data); writeErr != nil {
			failed++
			writer.Close()
			return nil
		}
		if closeErr := writer.Close(); closeErr != nil {
			failed++
			return nil
		}
		uploaded++
		return nil
	})
	if err != nil {
		log.Printf("[japanese gcs sync] walk error: %v", err)
	}
	if uploaded+skipped+failed > 0 {
		log.Printf("[japanese gcs sync] done: %d uploaded, %d skipped, %d failed", uploaded, skipped, failed)
	}
}

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

var (
	japaneseOnce  sync.Once
	japaneseMu    sync.RWMutex
	japaneseWords map[string][]JapaneseWord // category id -> words, load order preserved
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

// loadJapaneseCategory parses every *.csv under a category's directory and
// returns the combined word list in file order.
func loadJapaneseCategory(cat japaneseCategory) ([]JapaneseWord, error) {
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

	var words []JapaneseWord
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			log.Printf("[japanese] read %s/%s error: %v", cat.Dir, name, err)
			continue
		}
		data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF")) // strip UTF-8 BOM

		reader := csv.NewReader(bytes.NewReader(data))
		reader.FieldsPerRecord = -1
		reader.LazyQuotes = true
		rows, err := reader.ReadAll()
		if err != nil {
			log.Printf("[japanese] parse %s/%s error: %v", cat.Dir, name, err)
			continue
		}

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
	}
	return words, nil
}

// loadJapaneseWords loads every category into memory. Cheap enough (a few
// thousand short rows total) to just read from disk once at startup.
func loadJapaneseWords() {
	out := make(map[string][]JapaneseWord, len(japaneseCategories))
	total := 0
	for _, cat := range japaneseCategories {
		words, err := loadJapaneseCategory(cat)
		if err != nil {
			log.Printf("[japanese] skip category %s: %v", cat.ID, err)
			continue
		}
		out[cat.ID] = words
		total += len(words)
	}

	japaneseMu.Lock()
	japaneseWords = out
	japaneseMu.Unlock()

	log.Printf("[japanese] loaded %d words across %d categories", total, len(out))
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

		japaneseMu.RLock()
		words, ok := japaneseWords[category]
		japaneseMu.RUnlock()
		if !ok {
			http.Error(w, "unknown category: "+category, http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(words)
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

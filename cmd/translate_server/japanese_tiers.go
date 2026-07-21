package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Japanese "优先级" study source.
//
// The 分卷 / 五十音 sources slice the 新标日 wordlist by *word shape* (all-kanji,
// mixed, kana) — useful for reading practice, but they make you drill all 5805
// words evenly. This source slices the same corpus by *how much the word is
// worth for the interview*, so 必会 comes first and 别看 can be skipped outright.
//
// Data lives in data/japanese/tiers/<tierID>/<tierID>_partN.csv, rebuilt by
// scripts/build_tiers.py. Same 4-column layout as the 汉字 categories.
//
// Tiers 6/7 (专业词) are not in 新标日 at all and ship without audio; the
// frontend falls back to ja-JP TTS for those (see dictationTTSHandler's ?lang=).
// ---------------------------------------------------------------------------

type japaneseTier struct {
	ID    string // directory name under data/japanese/tiers/, also the ?tier= value
	Label string // display label
	Note  string // one-line hint shown under the button
}

// Order here is the order shown in the UI — most valuable first.
var japaneseTiers = []japaneseTier{
	{ID: "1_必会", Label: "必会", Note: "第1册基础词，不会就听不懂问题"},
	{ID: "2_普通掌握", Label: "普通掌握", Note: "第2册核心，商务与抽象词"},
	{ID: "3_掌握最好", Label: "掌握最好", Note: "有余力再背"},
	{ID: "4_会不会都行", Label: "会不会都行", Note: "不影响面试结果"},
	{ID: "5_别看", Label: "浪费时间别看", Note: "人名地名·剧情词，建议直接跳过"},
	{ID: "6_DCO专业词", Label: "DCO专业词", Note: "书里没有，岗位现场用语（TTS 发音）"},
	{ID: "7_JD点名词", Label: "JD点名词", Note: "变更管理·维护窗口·工单流程（TTS 发音）"},
}

// tierCategory is the parse spec for tier CSVs: always the 4-column layout.
// Category is set per-tier so the word objects carry a meaningful id.
func tierCategory(id string) japaneseCategory {
	return japaneseCategory{ID: id, Label: id, Kanji: true}
}

var (
	japaneseTierOnce  sync.Once
	japaneseTierMu    sync.RWMutex
	japaneseTierParts map[string][]japanesePart // tier id -> parts, natural order
	japaneseTierAll   map[string][]JapaneseWord // tier id -> flattened words
)

func japaneseTierDir() string {
	return filepath.Join(japaneseDataDir(), "tiers")
}

// loadJapaneseTierDir reads one tier's part CSVs, sorted naturally (part2
// before part10) so the on-screen numbering matches study order.
func loadJapaneseTierDir(t japaneseTier) []japanesePart {
	dir := filepath.Join(japaneseTierDir(), t.ID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil // tier not built yet — build with scripts/build_tiers.py
	}

	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".csv") {
			continue
		}
		names = append(names, e.Name())
	}
	sortCSVPartFiles(names)

	cat := tierCategory(t.ID)
	var parts []japanesePart
	for _, name := range names {
		words, err := parseJapaneseCSVFile(cat, filepath.Join(dir, name))
		if err != nil {
			log.Printf("[japanese tiers] parse %s/%s error: %v", t.ID, name, err)
			continue
		}
		if len(words) == 0 {
			continue
		}
		parts = append(parts, japanesePart{Name: name, Label: japanesePartLabel(name), Words: words})
	}
	return parts
}

func loadJapaneseTiers() {
	outParts := make(map[string][]japanesePart, len(japaneseTiers))
	outAll := make(map[string][]JapaneseWord, len(japaneseTiers))
	total := 0
	for _, t := range japaneseTiers {
		parts := loadJapaneseTierDir(t)
		if len(parts) == 0 {
			continue
		}
		var flat []JapaneseWord
		for _, p := range parts {
			flat = append(flat, p.Words...)
		}
		outParts[t.ID] = parts
		outAll[t.ID] = flat
		total += len(flat)
	}

	japaneseTierMu.Lock()
	japaneseTierParts = outParts
	japaneseTierAll = outAll
	japaneseTierMu.Unlock()

	log.Printf("[japanese tiers] loaded %d words across %d tiers", total, len(outAll))
}

func ensureJapaneseTiersLoaded() {
	japaneseTierOnce.Do(loadJapaneseTiers)
}

// japaneseTierInfo is returned by /japanese/tiers
type japaneseTierInfo struct {
	ID    string             `json:"id"`
	Label string             `json:"label"`
	Note  string             `json:"note"`
	Count int                `json:"count"`
	Parts []japanesePartInfo `json:"parts"`
}

// japaneseTiersHandler – GET /japanese/tiers → [{id,label,note,count,parts}]
// Tiers cut across the 4 word-shape categories, so this takes no ?category=.
func japaneseTiersHandler() http.HandlerFunc {
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

		ensureJapaneseTiersLoaded()

		japaneseTierMu.RLock()
		out := make([]japaneseTierInfo, 0, len(japaneseTiers))
		for _, t := range japaneseTiers {
			parts, ok := japaneseTierParts[t.ID]
			if !ok {
				continue // not built on disk
			}
			pinfo := make([]japanesePartInfo, 0, len(parts))
			for _, p := range parts {
				pinfo = append(pinfo, japanesePartInfo{Part: p.Name, Label: p.Label, Count: len(p.Words)})
			}
			out = append(out, japaneseTierInfo{
				ID: t.ID, Label: t.Label, Note: t.Note,
				Count: len(japaneseTierAll[t.ID]), Parts: pinfo,
			})
		}
		japaneseTierMu.RUnlock()

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(out)
	}
}

// japaneseTierWordsHandler – GET /japanese/tier-words?tier=1_必会[&part=X] → words
// Without ?part= returns the whole tier; with it, just that part CSV.
func japaneseTierWordsHandler() http.HandlerFunc {
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

		ensureJapaneseTiersLoaded()

		tier := r.URL.Query().Get("tier")
		if tier == "" {
			http.Error(w, "missing tier parameter", http.StatusBadRequest)
			return
		}
		part := r.URL.Query().Get("part")

		japaneseTierMu.RLock()
		words, ok := japaneseTierAll[tier]
		if ok && part != "" {
			found := false
			for _, p := range japaneseTierParts[tier] {
				if p.Name == part {
					words = p.Words
					found = true
					break
				}
			}
			ok = found
		}
		japaneseTierMu.RUnlock()
		if !ok {
			http.Error(w, "unknown tier/part", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(words)
	}
}

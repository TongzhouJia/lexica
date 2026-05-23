package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// ---------------------------------------------------------------------------
// Disk cache: translations  →  data/translate_server/cache.json
// ---------------------------------------------------------------------------

func translateCachePath() string {
	return filepath.Join(projectRoot, "data", "translate_server", "cache.json")
}

// loadTranslateCache reads the JSON cache file into the sync.Map
func loadTranslateCache() {
	path := translateCachePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return // no cache file yet
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		log.Printf("[cache] failed to parse %s: %v", path, err)
		return
	}
	for k, v := range m {
		cache.Store(k, v)
	}
	log.Printf("[cache] loaded %d translations from disk", len(m))
}

// saveTranslateCache writes the full sync.Map out to disk
func saveTranslateCache() {
	m := make(map[string]string)
	cache.Range(func(k, v any) bool {
		m[k.(string)] = v.(string)
		return true
	})
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		log.Printf("[cache] marshal error: %v", err)
		return
	}
	dir := filepath.Dir(translateCachePath())
	os.MkdirAll(dir, 0755)
	if err := os.WriteFile(translateCachePath(), data, 0644); err != nil {
		log.Printf("[cache] write error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Disk cache: TTS audio  →  data/tts_cache/<hash>.mp3
// (shared with gsay)
// ---------------------------------------------------------------------------

func ttsCacheDir() string {
	return filepath.Join(projectRoot, "data", "tts_cache")
}

func textHash(text string) string {
	h := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%x", h)[:16]
}

// loadTTSCache scans existing MP3 files and their index
func loadTTSCache() {
	dir := ttsCacheDir()
	indexPath := filepath.Join(dir, "index.json")
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return
	}
	var m map[string]string // text → filename
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	count := 0
	for text, filename := range m {
		mp3Path := filepath.Join(dir, filename)
		if _, err := os.Stat(mp3Path); err == nil {
			ttsCache.Store(text, mp3Path)
			count++
		}
	}
	log.Printf("[tts cache] loaded %d entries from disk", count)
}

// saveTTSAudio writes MP3 to disk and updates the index
func saveTTSAudio(text string, audioBytes []byte) string {
	dir := ttsCacheDir()
	os.MkdirAll(dir, 0755)

	filename := textHash(text) + ".mp3"
	mp3Path := filepath.Join(dir, filename)

	if err := os.WriteFile(mp3Path, audioBytes, 0644); err != nil {
		log.Printf("[tts cache] write error: %v", err)
		return ""
	}

	// Update index.json
	indexPath := filepath.Join(dir, "index.json")
	m := make(map[string]string)
	if data, err := os.ReadFile(indexPath); err == nil {
		json.Unmarshal(data, &m)
	}
	m[text] = filename
	if data, err := json.MarshalIndent(m, "", "  "); err == nil {
		os.WriteFile(indexPath, data, 0644)
	}

	return mp3Path
}

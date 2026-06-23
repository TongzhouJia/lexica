package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Vocabulary Progress (Sankey)
//
// A "progress" is a tracked wordlist identified by a UUID, reachable at its own
// URL /progress/<uuid>. Each time the user pastes a CSV (exported from a
// dictation/recognition result page) it is appended as a new "round". The first
// round is the full set; every later round is meant to be a subset of the
// previous one (the words still not mastered). The frontend renders the
// shrinking sets as a Sankey diagram where mastered words fork off each round.
//
// Data is persisted server-side as one JSON file per progress, so it survives
// across browsers/devices.
// ---------------------------------------------------------------------------

// ProgressRound is a single pasted batch of words at a point in time.
type ProgressRound struct {
	PastedAt string          `json:"pastedAt"`
	Words    []DictationWord `json:"words"`
}

// ProgressDoc is the full persisted document for one tracked wordlist.
type ProgressDoc struct {
	ID        string          `json:"id"`
	CreatedAt string          `json:"createdAt"`
	Rounds    []ProgressRound `json:"rounds"`
}

func progressDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "progress")
}

// newUUID returns a random RFC-4122 v4 UUID string.
func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is exceptional; fall back to a timestamp so we
		// never hand back an empty id.
		return fmt.Sprintf("ts-%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// safeProgressID rejects ids that could escape progressDir().
func safeProgressID(id string) bool {
	return id != "" && !strings.ContainsAny(id, "/\\.")
}

func nowUTC8() string {
	loc := time.FixedZone("UTC+8", 8*60*60)
	return time.Now().In(loc).Format(time.RFC3339)
}

func loadProgressDoc(id string) (*ProgressDoc, error) {
	data, err := os.ReadFile(filepath.Join(progressDir(), id+".json"))
	if err != nil {
		return nil, err
	}
	var doc ProgressDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	return &doc, nil
}

func saveProgressDoc(doc *ProgressDoc) error {
	if err := os.MkdirAll(progressDir(), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(progressDir(), doc.ID+".json"), data, 0644)
}

// progressHandler serves both the standalone page and the JSON API, all under
// the /progress/ prefix. The trailing path segment selects the action; anything
// that is not a reserved keyword is treated as a UUID and serves the HTML page
// (the frontend then reads the UUID from location.pathname).
func progressHandler() http.HandlerFunc {
	page := lexicaAssetHandler("progress.html", "text/html; charset=utf-8")
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		seg := strings.TrimPrefix(r.URL.Path, "/progress/")
		switch seg {
		case "list":
			progressList(w, r)
		case "create":
			progressCreate(w, r)
		case "get":
			progressGet(w, r)
		case "paste":
			progressPaste(w, r)
		case "delete":
			progressDelete(w, r)
		case "delete-round":
			progressDeleteRound(w, r)
		default:
			// /progress/<uuid> (or /progress/) → serve the page shell.
			page(w, r)
		}
	}
}

type progressListItem struct {
	ID         string `json:"id"`
	CreatedAt  string `json:"createdAt"`
	RoundCount int    `json:"roundCount"`
	TotalWords int    `json:"totalWords"` // words in the first (full) round
	Remaining  int    `json:"remaining"`  // words in the latest round
	LastPaste  string `json:"lastPaste"`
}

// progressList – GET /progress/list → all tracked wordlists, newest first.
func progressList(w http.ResponseWriter, _ *http.Request) {
	entries, err := os.ReadDir(progressDir())
	items := make([]progressListItem, 0)
	if err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			id := strings.TrimSuffix(e.Name(), ".json")
			doc, err := loadProgressDoc(id)
			if err != nil {
				continue
			}
			item := progressListItem{
				ID:         doc.ID,
				CreatedAt:  doc.CreatedAt,
				RoundCount: len(doc.Rounds),
			}
			if len(doc.Rounds) > 0 {
				item.TotalWords = len(doc.Rounds[0].Words)
				last := doc.Rounds[len(doc.Rounds)-1]
				item.Remaining = len(last.Words)
				item.LastPaste = last.PastedAt
			}
			items = append(items, item)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt > items[j].CreatedAt })
	writeJSON(w, items)
}

// progressCreate – POST /progress/create → {id} of a new empty wordlist.
func progressCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	doc := &ProgressDoc{ID: newUUID(), CreatedAt: nowUTC8(), Rounds: []ProgressRound{}}
	if err := saveProgressDoc(doc); err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}
	log.Printf("[progress] created %s", doc.ID)
	writeJSON(w, map[string]string{"id": doc.ID})
}

// progressGet – GET /progress/get?id=X → the full ProgressDoc.
func progressGet(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if !safeProgressID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	doc, err := loadProgressDoc(id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, doc)
}

// progressPaste – POST /progress/paste {id, words:[{english,chinese}]} appends a round.
func progressPaste(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ID    string          `json:"id"`
		Words []DictationWord `json:"words"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if !safeProgressID(req.ID) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	if len(req.Words) == 0 {
		http.Error(w, "no words", http.StatusBadRequest)
		return
	}
	doc, err := loadProgressDoc(req.ID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	doc.Rounds = append(doc.Rounds, ProgressRound{PastedAt: nowUTC8(), Words: req.Words})
	if err := saveProgressDoc(doc); err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}
	log.Printf("[progress] %s round %d (+%d words)", doc.ID, len(doc.Rounds), len(req.Words))
	writeJSON(w, doc)
}

// progressDeleteRound – POST /progress/delete-round {id, index} removes one round.
func progressDeleteRound(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ID    string `json:"id"`
		Index int    `json:"index"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if !safeProgressID(req.ID) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	doc, err := loadProgressDoc(req.ID)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if req.Index < 0 || req.Index >= len(doc.Rounds) {
		http.Error(w, "bad index", http.StatusBadRequest)
		return
	}
	doc.Rounds = append(doc.Rounds[:req.Index], doc.Rounds[req.Index+1:]...)
	if err := saveProgressDoc(doc); err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, doc)
}

// progressDelete – POST /progress/delete?id=X removes a whole wordlist.
func progressDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	id := r.URL.Query().Get("id")
	if !safeProgressID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	if err := os.Remove(filepath.Join(progressDir(), id+".json")); err != nil && !os.IsNotExist(err) {
		http.Error(w, "delete failed", http.StatusInternalServerError)
		return
	}
	log.Printf("[progress] deleted %s", id)
	writeJSON(w, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

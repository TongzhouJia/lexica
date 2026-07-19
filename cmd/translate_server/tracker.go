package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// ---------------------------------------------------------------------------
// Check-in trackers
//
// A "tracker" is a flat set of check-in flags identified by a short id:
//   letters — the 26-letter English word tracker (home-screen board)
//   kana    — the 五十音 Japanese board, two flags per kana (one per category),
//             keyed "<category>|<kana>"
//
// Both used to live in localStorage, which meant progress vanished when the
// user switched browsers. They are now persisted server-side as one JSON file
// per tracker under data/translate_server/tracker/, so any browser hitting the
// same server sees the same progress.
// ---------------------------------------------------------------------------

// TrackerDoc is the full persisted document for one tracker.
type TrackerDoc struct {
	ID        string          `json:"id"`
	Checked   map[string]bool `json:"checked"`
	UpdatedAt string          `json:"updatedAt"`
}

func trackerDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "tracker")
}

// Ticking two cards in quick succession fires two overlapping POSTs. Without
// this lock both handlers write the same file at once and the loser's bytes
// land inside the winner's, leaving unparseable JSON — i.e. lost progress.
var trackerMu sync.Mutex

func loadTrackerDoc(id string) *TrackerDoc {
	doc := &TrackerDoc{ID: id, Checked: map[string]bool{}}
	data, err := os.ReadFile(filepath.Join(trackerDir(), id+".json"))
	if err != nil {
		return doc // missing file = empty tracker, not an error
	}
	if err := json.Unmarshal(data, doc); err != nil {
		log.Printf("[tracker] corrupt %s.json, starting empty: %v", id, err)
		return &TrackerDoc{ID: id, Checked: map[string]bool{}}
	}
	if doc.Checked == nil {
		doc.Checked = map[string]bool{}
	}
	doc.ID = id
	return doc
}

func saveTrackerDoc(doc *TrackerDoc) error {
	if err := os.MkdirAll(trackerDir(), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	// Write-then-rename: a reader (or a crash mid-write) never sees a partially
	// written file, since rename is atomic within the directory.
	path := filepath.Join(trackerDir(), doc.ID+".json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// trackerHandler serves the whole /tracker/ API:
//
//	GET  /tracker/get?id=X          → TrackerDoc (empty one if never saved)
//	POST /tracker/set {id, checked} → replaces the flag set, returns TrackerDoc
//
// The client always sends the complete map, so a set is idempotent and there is
// no merge to get wrong.
func trackerHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		switch r.URL.Path {
		case "/tracker/get":
			id := r.URL.Query().Get("id")
			if !safeProgressID(id) {
				http.Error(w, "invalid id", http.StatusBadRequest)
				return
			}
			trackerMu.Lock()
			doc := loadTrackerDoc(id)
			trackerMu.Unlock()
			writeJSON(w, doc)
		case "/tracker/set":
			if r.Method != http.MethodPost {
				http.Error(w, "POST only", http.StatusMethodNotAllowed)
				return
			}
			var req struct {
				ID      string          `json:"id"`
				Checked map[string]bool `json:"checked"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if !safeProgressID(req.ID) {
				http.Error(w, "invalid id", http.StatusBadRequest)
				return
			}
			if req.Checked == nil {
				req.Checked = map[string]bool{}
			}
			// Drop false entries so the file only ever lists what is done.
			checked := make(map[string]bool, len(req.Checked))
			for k, v := range req.Checked {
				if v {
					checked[k] = true
				}
			}
			doc := &TrackerDoc{ID: req.ID, Checked: checked, UpdatedAt: nowUTC8()}
			trackerMu.Lock()
			err := saveTrackerDoc(doc)
			trackerMu.Unlock()
			if err != nil {
				http.Error(w, "save failed", http.StatusInternalServerError)
				return
			}
			log.Printf("[tracker] %s saved (%d checked)", doc.ID, len(checked))
			writeJSON(w, doc)
		default:
			http.NotFound(w, r)
		}
	}
}

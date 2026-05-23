package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// lexicaHandler – GET /lexica → serves lexica.html from cmd/translate_server/
func lexicaHandler() http.HandlerFunc {
	return lexicaAssetHandler("lexica.html", "text/html; charset=utf-8")
}

// lexicaAssetHandler – generic static-file handler for lexica's bundle
// (html/css/js). Reads from cmd/translate_server/<filename>.
func lexicaAssetHandler(filename, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(projectRoot, "cmd", "translate_server", filename)
		data, err := os.ReadFile(path)
		if err != nil {
			log.Printf("[lexica] read %s error: %v", filename, err)
			http.Error(w, filename+" not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	}
}

package main

import (
	"embed"
	"log"
	"net/http"
)

// webFS bundles the frontend assets (html/css/js) into the binary so the
// server is self-contained and no longer depends on projectRoot at runtime.
//
//go:embed web/*
var webFS embed.FS

// lexicaHandler – GET /lexica → serves web/lexica.html
func lexicaHandler() http.HandlerFunc {
	return lexicaAssetHandler("lexica.html", "text/html; charset=utf-8")
}

// lexicaAssetHandler – generic static-file handler for lexica's bundle
// (html/css/js), reading from the embedded web/ directory.
func lexicaAssetHandler(filename, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile("web/" + filename)
		if err != nil {
			log.Printf("[lexica] read %s error: %v", filename, err)
			http.Error(w, filename+" not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	}
}

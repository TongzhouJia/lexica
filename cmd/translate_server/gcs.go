package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"cloud.google.com/go/storage"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
)

// ---------------------------------------------------------------------------
// GCS helpers
// ---------------------------------------------------------------------------

// resolveCredentials finds the service account JSON file.
// Search order: GOOGLE_APPLICATION_CREDENTIALS, credentials/, legacy cmd path, then project root.
func resolveCredentials() string {
	if envPath := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")); envPath != "" {
		if abs, err := filepath.Abs(envPath); err == nil {
			return abs
		}
		return envPath
	}

	candidateDirs := []string{
		filepath.Join(projectRoot, "credentials"),
		filepath.Join(projectRoot, "cmd", "translate_server", "credentials"),
		projectRoot,
	}
	for _, dir := range candidateDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "vertex-") && strings.HasSuffix(e.Name(), ".json") {
				return filepath.Join(dir, e.Name())
			}
		}
	}
	return ""
}

func newGCSClient(ctx context.Context, credPath string) (*storage.Client, error) {
	if credPath != "" {
		return storage.NewClient(ctx, option.WithCredentialsFile(credPath))
	}
	if os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" {
		return storage.NewClient(ctx)
	}
	return nil, fmt.Errorf("GCS credentials not found; put vertex-*.json under credentials/ or set GOOGLE_APPLICATION_CREDENTIALS")
}

// GCSFileInfo is returned by /gcs/list
type GCSFileInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type GCSListResponse struct {
	Bucket string        `json:"bucket"`
	Prefix string        `json:"prefix"`
	Files  []GCSFileInfo `json:"files"`
}

func writeCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// gcsListHandler – GET /gcs/list → JSON array of files under the configured prefix
func gcsListHandler(bucketName, prefix, credPath string) http.HandlerFunc {
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
		if bucketName == "" {
			http.Error(w, "GCS bucket is not configured", http.StatusInternalServerError)
			return
		}

		ctx := context.Background()
		client, err := newGCSClient(ctx, credPath)
		if err != nil {
			log.Printf("[gcs list] client error: %v", err)
			http.Error(w, "GCS client error", http.StatusInternalServerError)
			return
		}
		defer client.Close()

		var files []GCSFileInfo
		it := client.Bucket(bucketName).Objects(ctx, &storage.Query{Prefix: prefix})
		for {
			attrs, err := it.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				log.Printf("[gcs list] iterator error: %v", err)
				http.Error(w, "GCS list error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			// Skip "directory" markers (zero-size objects ending with /)
			if strings.HasSuffix(attrs.Name, "/") {
				continue
			}
			// Return the name relative to the prefix for cleaner display
			displayName := strings.TrimPrefix(attrs.Name, prefix)
			if displayName == "" {
				continue
			}
			files = append(files, GCSFileInfo{
				Name: displayName,
				Size: attrs.Size,
			})
		}
		sort.Slice(files, func(i, j int) bool {
			return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
		})

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(GCSListResponse{
			Bucket: bucketName,
			Prefix: prefix,
			Files:  files,
		})
	}
}

// gcsDownloadHandler – GET /gcs/download?name=xxx → file content
func gcsDownloadHandler(bucketName, prefix, credPath string) http.HandlerFunc {
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
		if bucketName == "" {
			http.Error(w, "GCS bucket is not configured", http.StatusInternalServerError)
			return
		}

		name := r.URL.Query().Get("name")
		if name == "" {
			http.Error(w, "missing name parameter", http.StatusBadRequest)
			return
		}

		// Security: prevent path traversal
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "\\") {
			http.Error(w, "invalid name", http.StatusBadRequest)
			return
		}

		objectName := prefix + name

		ctx := context.Background()
		client, err := newGCSClient(ctx, credPath)
		if err != nil {
			log.Printf("[gcs download] client error: %v", err)
			http.Error(w, "GCS client error", http.StatusInternalServerError)
			return
		}
		defer client.Close()

		reader, err := client.Bucket(bucketName).Object(objectName).NewReader(ctx)
		if err != nil {
			log.Printf("[gcs download] read error for %s: %v", objectName, err)
			http.Error(w, "file not found: "+err.Error(), http.StatusNotFound)
			return
		}
		defer reader.Close()

		// Determine content type from extension
		ext := filepath.Ext(name)
		contentType := mime.TypeByExtension(ext)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, filepath.Base(name)))

		if _, err := io.Copy(w, reader); err != nil {
			log.Printf("[gcs download] copy error: %v", err)
		}
	}
}

package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/option"
)

// ---------------------------------------------------------------------------
// Package-wide state (project root, in-memory caches, Firestore client)
// ---------------------------------------------------------------------------

var projectRoot string

var (
	cache        sync.Map // translate cache: "sl:tl:text" → translated string
	ttsCache     sync.Map // TTS cache: text → MP3 file path on disk
	vocabularyMu sync.Mutex

	// Firestore client used for dictation word lists and clean_sync metadata
	firestoreClient *firestore.Client
)

// ---------------------------------------------------------------------------
// Load .env (minimal parser, no third-party deps)
// ---------------------------------------------------------------------------

func loadEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return // silently skip if .env missing
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		// strip surrounding quotes
		val = strings.Trim(val, `"'`)
		os.Setenv(key, val)
	}
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

func main() {
	// Resolve project root (works from cmd/translate_server/ or project root)
	// Try ../../ first (running from cmd/translate_server/), then current dir
	if _, err := os.Stat("../../.env"); err == nil {
		projectRoot, _ = filepath.Abs("../../")
	} else if _, err := os.Stat(".env"); err == nil {
		projectRoot, _ = filepath.Abs(".")
	} else {
		// fallback: absolute path
		home, _ := os.UserHomeDir()
		projectRoot = filepath.Join(home, "GolandProjects", "lexica")
	}

	// Load .env
	loadEnv(filepath.Join(projectRoot, ".env"))

	translateKey := os.Getenv("GOOGLE_TRANSLATE_API_KEY")
	if translateKey == "" {
		translateKey = os.Getenv("GOOGLE_TTS_API_KEY")
	}
	if translateKey == "" {
		log.Fatal("Set GOOGLE_TRANSLATE_API_KEY in .env")
	}

	ttsKey := os.Getenv("GOOGLE_TTS_API_KEY")
	if ttsKey == "" {
		log.Fatal("Set GOOGLE_TTS_API_KEY in .env")
	}

	geminiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	geminiModel := strings.TrimSpace(os.Getenv("GEMINI_MODEL"))
	if geminiModel == "" {
		geminiModel = defaultGeminiModel
	}
	if geminiKey == "" {
		log.Println("[warn] GEMINI_API_KEY not set – /trace/ask will return an error")
	} else {
		log.Printf("[init] Gemini model: %s", geminiModel)
	}

	// GCS configuration
	gcsBucket := os.Getenv("GCS_BUCKET")
	if gcsBucket == "" {
		gcsBucket = "cloud-storage-jtz"
	}
	gcsPrefix := os.Getenv("GCS_PREFIX")
	if gcsPrefix == "" {
		gcsPrefix = "study-english/"
	}

	credPath := resolveCredentials()
	if credPath == "" {
		log.Println("[warn] No GCS credentials found – /gcs/* endpoints will fail")
	} else {
		log.Printf("[init] GCS credentials: %s", credPath)
	}

	// Load disk caches
	loadTranslateCache()
	loadTTSCache()
	purgeOldActivityLogs()
	log.Printf("[init] project root: %s", projectRoot)

	// Initialize Firestore client (used for dictation word lists)
	if credPath != "" {
		fsCtx := context.Background()
		fsClient, fsErr := firestore.NewClientWithDatabase(fsCtx, "vertex-jtz", "firestore-test", option.WithCredentialsFile(credPath))
		if fsErr != nil {
			log.Printf("[warn] Firestore init failed: %v – running in local-only mode", fsErr)
		} else {
			firestoreClient = fsClient
			log.Println("[init] Firestore connected: vertex-jtz/firestore-test")
		}
	}

	// One-time import: copy daily_english_word/*.txt from GCS into Firestore
	go importDailyWordsFromGCS(gcsBucket, credPath)

	http.HandleFunc("/", translateHandler(translateKey, ttsKey))
	http.HandleFunc("/play", playHandler(ttsKey))
	http.HandleFunc("/save", saveHandler())
	http.HandleFunc("/lexica", lexicaHandler())
	http.HandleFunc("/lexica.css", lexicaAssetHandler("lexica.css", "text/css; charset=utf-8"))
	http.HandleFunc("/lexica.js", lexicaAssetHandler("lexica.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/gcs/list", gcsListHandler(gcsBucket, gcsPrefix, credPath))
	http.HandleFunc("/gcs/download", gcsDownloadHandler(gcsBucket, gcsPrefix, credPath))
	http.HandleFunc("/dictation/days", dictationDaysHandler())
	http.HandleFunc("/dictation/words", dictationWordsHandler())
	http.HandleFunc("/dictation/update-word", dictationUpdateWordHandler())
	http.HandleFunc("/dictation/load-csv", dictationLoadCSVHandler())
	http.HandleFunc("/session/record", sessionRecordHandler())
	http.HandleFunc("/session/list", sessionListHandler())
	http.HandleFunc("/session/csv", sessionCSVHandler())
	http.HandleFunc("/studytime/segment", studyTimeSegmentHandler())
	http.HandleFunc("/studytime/today", studyTimeTodayHandler())
	http.HandleFunc("/stats/inc", statsIncHandler())
	http.HandleFunc("/stats/today", statsTodayHandler())
	http.HandleFunc("/sun/today", sunTodayHandler())
	http.HandleFunc("/dictation/tts", dictationTTSHandler(ttsKey))
	http.HandleFunc("/trace/record", traceRecordHandler())
	http.HandleFunc("/trace/list", traceListHandler())
	http.HandleFunc("/trace/delete", traceDeleteHandler())
	http.HandleFunc("/trace/ask", traceAskHandler(geminiKey, geminiModel))
	http.HandleFunc("/clean", cleanHandler())
	http.HandleFunc("/clean/sync", cleanSyncHandler())
	http.HandleFunc("/activity/list", activityLogListHandler())
	http.HandleFunc("/gmail/auth", gmailAuthHandler())
	http.HandleFunc("/gmail/callback", gmailCallbackHandler())
	http.HandleFunc("/gmail/status", gmailStatusHandler())
	http.HandleFunc("/email/send", emailSendHandler(geminiKey, geminiModel))
	http.HandleFunc("/email/reminder", emailReminderHandler())

	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	fmt.Printf("Listening on http://%s\n", addr)
	fmt.Printf("  Lexica reader: http://%s/lexica\n", addr)
	fmt.Printf("  Dictation:     http://%s/lexica (toggle button)\n", addr)
	fmt.Printf("  GCS bucket: %s (prefix: %s)\n", gcsBucket, gcsPrefix)
	log.Fatal(http.ListenAndServe(addr, nil))
}

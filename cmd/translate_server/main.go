package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net"
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
	// One-time import: copy alphabet_order_word/*.txt from GCS into Firestore
	go importAlphabetWordsFromGCS(gcsBucket, credPath)

	http.HandleFunc("/", translateHandler(translateKey, ttsKey))
	http.HandleFunc("/play", playHandler(ttsKey))
	http.HandleFunc("/save", saveHandler())
	http.HandleFunc("/lexica", lexicaHandler())
	http.HandleFunc("/lexica.css", lexicaAssetHandler("lexica.css", "text/css; charset=utf-8"))
	http.HandleFunc("/markdown-theme.css", lexicaAssetHandler("markdown-theme.css", "text/css; charset=utf-8"))
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
	http.HandleFunc("/dictation/alphabet-letters", dictationAlphabetLettersHandler())
	http.HandleFunc("/dictation/alphabet-words", dictationAlphabetWordsHandler())
	http.HandleFunc("/clean", cleanHandler())
	http.HandleFunc("/clean/sync", cleanSyncHandler())

	// Bind on all interfaces by default so other machines on the LAN can
	// reach the server via this host's IP. Override with LISTEN_ADDR
	// (e.g. 127.0.0.1:8080 to restrict back to loopback only).
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8080"
	}
	_, port, _ := net.SplitHostPort(addr)
	fmt.Printf("Listening on http://%s\n", addr)
	fmt.Printf("  Local:   http://127.0.0.1:%s/lexica\n", port)
	if ip := lanIP(); ip != "" {
		fmt.Printf("  Network: http://%s:%s/lexica  (open this from other LAN devices)\n", ip, port)
	}
	fmt.Printf("  Dictation: use the toggle button on /lexica\n")
	fmt.Printf("  GCS bucket: %s (prefix: %s)\n", gcsBucket, gcsPrefix)
	log.Fatal(http.ListenAndServe(addr, nil))
}

// lanIP returns this host's LAN IPv4 address to print as a hint. It walks the
// up, non-loopback interfaces and prefers a private-range address
// (192.168/16, 10/8, 172.16/12) — the kind other devices on the same network
// can actually reach — over VPN/tunnel addresses. Returns "" if none found.
func lanIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil {
				continue
			}
			if ip.IsPrivate() {
				return ip.String()
			}
			if fallback == "" {
				fallback = ip.String()
			}
		}
	}
	return fallback
}

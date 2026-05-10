package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Google Translate API v2 response structures
// ---------------------------------------------------------------------------

type translateResponse struct {
	Data struct {
		Translations []struct {
			TranslatedText string `json:"translatedText"`
		} `json:"translations"`
	} `json:"data"`
}

// ---------------------------------------------------------------------------
// In-memory cache  key = "sl:tl:text"
// ---------------------------------------------------------------------------

var cache sync.Map

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
// Call Google Translate API v2
// ---------------------------------------------------------------------------

func translate(apiKey, text, sl, tl string) (string, error) {
	endpoint := "https://translation.googleapis.com/language/translate/v2"

	params := url.Values{}
	params.Set("key", apiKey)
	params.Set("q", text)
	params.Set("source", sl)
	params.Set("target", tl)
	params.Set("format", "text")

	resp, err := http.Get(endpoint + "?" + params.Encode())
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read body failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var result translateResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("JSON decode failed: %w", err)
	}

	if len(result.Data.Translations) == 0 {
		return "", fmt.Errorf("no translation returned")
	}

	return result.Data.Translations[0].TranslatedText, nil
}

// ---------------------------------------------------------------------------
// HTML templates (inline CSS, large font)
// ---------------------------------------------------------------------------

func renderSuccess(text, translated, sl, tl string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Translate</title>
</head>
<body style="
  margin:0; min-height:100vh;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);
  font-family:'Segoe UI',system-ui,sans-serif; color:#e0e0e0;
">
  <div style="
    background:rgba(255,255,255,0.06);
    backdrop-filter:blur(12px);
    border:1px solid rgba(255,255,255,0.12);
    border-radius:24px; padding:48px 56px;
    max-width:680px; width:90%%;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
    text-align:center;
  ">
    <p style="font-size:14px;opacity:0.5;margin:0 0 8px;letter-spacing:2px;">%s → %s</p>
    <p style="font-size:42px;font-weight:700;margin:0 0 16px;
              background:linear-gradient(90deg,#a78bfa,#60a5fa);
              -webkit-background-clip:text;-webkit-text-fill-color:transparent;">%s</p>
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:20px 0;">
    <p style="font-size:36px;font-weight:400;margin:0;color:#c4b5fd;">%s</p>
  </div>
</body>
</html>`,
		htmlEscape(strings.ToUpper(sl)),
		htmlEscape(strings.ToUpper(tl)),
		htmlEscape(text),
		htmlEscape(translated),
	)
}

func renderError(msg string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
</head>
<body style="
  margin:0; min-height:100vh;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,#1a0000,#4a1942,#1a0000);
  font-family:'Segoe UI',system-ui,sans-serif; color:#e0e0e0;
">
  <div style="
    background:rgba(255,60,60,0.08);
    backdrop-filter:blur(12px);
    border:1px solid rgba(255,100,100,0.2);
    border-radius:24px; padding:48px 56px;
    max-width:600px; width:90%%;
    box-shadow:0 8px 32px rgba(0,0,0,0.5);
    text-align:center;
  ">
    <p style="font-size:48px;margin:0 0 12px;">⚠️</p>
    <p style="font-size:24px;font-weight:600;margin:0 0 16px;color:#fca5a5;">Something went wrong</p>
    <p style="font-size:16px;opacity:0.7;margin:0;">%s</p>
  </div>
</body>
</html>`, htmlEscape(msg))
}

// htmlEscape without html/template – just the 5 XML entities
func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

func handler(apiKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			w.WriteHeader(http.StatusNotFound)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, renderError("Page not found"))
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, renderError("Only GET is allowed"))
			return
		}

		q := r.URL.Query()
		text := q.Get("text")
		sl := q.Get("sl")
		tl := q.Get("tl")

		if text == "" || sl == "" || tl == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, renderError("Missing required query parameters: text, sl, tl"))
			return
		}

		// Cache lookup
		cacheKey := sl + ":" + tl + ":" + text
		if cached, ok := cache.Load(cacheKey); ok {
			log.Printf("[cache hit] %s", cacheKey)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, renderSuccess(text, cached.(string), sl, tl))
			return
		}

		// Call API
		translated, err := translate(apiKey, text, sl, tl)
		if err != nil {
			log.Printf("[error] %v", err)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, renderError(err.Error()))
			return
		}

		// Store in cache
		cache.Store(cacheKey, translated)
		log.Printf("[translated] %s → %s", text, translated)

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, renderSuccess(text, translated, sl, tl))
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	// Load .env – try current dir and project root
	loadEnv(".env")
	loadEnv("../../.env")

	apiKey := os.Getenv("GOOGLE_TRANSLATE_API_KEY")
	if apiKey == "" {
		// fallback: reuse TTS key (same GCP project)
		apiKey = os.Getenv("GOOGLE_TTS_API_KEY")
	}
	if apiKey == "" {
		log.Fatal("Set GOOGLE_TRANSLATE_API_KEY or GOOGLE_TTS_API_KEY in .env")
	}

	http.HandleFunc("/", handler(apiKey))

	addr := "127.0.0.1:8080"
	fmt.Printf("Listening on http://%s\n", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

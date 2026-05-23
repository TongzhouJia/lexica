package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
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
// HTTP handler
// ---------------------------------------------------------------------------

func translateHandler(translateKey, ttsKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, renderError("Page not found"))
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusMethodNotAllowed)
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

		// Play TTS locally if source is English (non-blocking)
		if strings.HasPrefix(strings.ToLower(sl), "en") {
			playLocal(ttsKey, text)
		}

		// Cache lookup
		cacheKey := sl + ":" + tl + ":" + text
		if cached, ok := cache.Load(cacheKey); ok {
			translated := cached.(string)
			log.Printf("[cache hit] %s", cacheKey)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, renderSuccess(text, translated, sl, tl, isVocabularySaved(text, translated, sl)))
			return
		}

		// Call API
		translated, err := translate(translateKey, text, sl, tl)
		if err != nil {
			log.Printf("[error] %v", err)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, renderError(err.Error()))
			return
		}

		// Store in memory + disk cache
		cache.Store(cacheKey, translated)
		saveTranslateCache()
		log.Printf("[translated] %s → %s", text, translated)

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, renderSuccess(text, translated, sl, tl, isVocabularySaved(text, translated, sl)))
	}
}

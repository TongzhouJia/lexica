package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Dictation traces + Gemini AI analysis
// ---------------------------------------------------------------------------

// Default Gemini/Gemma model. Override via GEMINI_MODEL env if needed.
const defaultGeminiModel = "gemma-4-31b-it"

type TraceWord struct {
	English    string   `json:"english"`
	Chinese    string   `json:"chinese"`
	Attempts   []string `json:"attempts"`
	AttemptMs  []int    `json:"attemptMs,omitempty"` // ms per attempt (parallel to Attempts)
	Skipped    bool     `json:"skipped"`
	FirstTryOK bool     `json:"firstTryOK"`
	ErrorCount int      `json:"errorCount"`
	TotalMs    int      `json:"totalMs,omitempty"` // total ms for this word
}

type TraceRecord struct {
	ID              string      `json:"id"`
	Timestamp       string      `json:"timestamp"` // RFC3339 in +08:00
	DayName         string      `json:"dayName"`
	Mode            string      `json:"mode"`
	Words           []TraceWord `json:"words"`
	Total           int         `json:"total"`
	FirstTryCorrect int         `json:"firstTryCorrect"`
	Wrong           int         `json:"wrong"`
}

func tracesDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "traces")
}

// traceRecordHandler – POST /trace/record  (body: TraceRecord JSON)
func traceRecordHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var rec TraceRecord
		if err := json.NewDecoder(r.Body).Decode(&rec); err != nil {
			http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
			return
		}
		loc := time.FixedZone("UTC+8", 8*60*60)
		now := time.Now().In(loc)
		if rec.Timestamp == "" {
			rec.Timestamp = now.Format(time.RFC3339)
		}
		if rec.ID == "" {
			rec.ID = now.Format("20060102-150405") + fmt.Sprintf("-%d", now.UnixNano()%1000)
		}
		if err := os.MkdirAll(tracesDir(), 0755); err != nil {
			log.Printf("[trace mkdir] %v", err)
			http.Error(w, "mkdir failed", http.StatusInternalServerError)
			return
		}
		path := filepath.Join(tracesDir(), rec.ID+".json")
		data, err := json.MarshalIndent(rec, "", "  ")
		if err != nil {
			http.Error(w, "marshal failed", http.StatusInternalServerError)
			return
		}
		if err := os.WriteFile(path, data, 0644); err != nil {
			log.Printf("[trace save] %v", err)
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		log.Printf("[trace saved] %s (%s, %d words)", rec.ID, rec.DayName, len(rec.Words))
		appendActivityLog("dictation", fmt.Sprintf("听写 %s: %d词, 正确%d, 错误%d", rec.DayName, rec.Total, rec.FirstTryCorrect, rec.Wrong), nil)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": rec.ID})
	}
}

type traceListItem struct {
	ID              string `json:"id"`
	Timestamp       string `json:"timestamp"`
	DayName         string `json:"dayName"`
	Mode            string `json:"mode"`
	Total           int    `json:"total"`
	FirstTryCorrect int    `json:"firstTryCorrect"`
	Wrong           int    `json:"wrong"`
}

// traceListHandler – GET /trace/list → JSON array (newest first)
func traceListHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		entries, err := os.ReadDir(tracesDir())
		if err != nil {
			if os.IsNotExist(err) {
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte("[]"))
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		items := []traceListItem{}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(tracesDir(), e.Name()))
			if err != nil {
				continue
			}
			var rec TraceRecord
			if err := json.Unmarshal(data, &rec); err != nil {
				continue
			}
			items = append(items, traceListItem{
				ID: rec.ID, Timestamp: rec.Timestamp, DayName: rec.DayName,
				Mode: rec.Mode, Total: rec.Total,
				FirstTryCorrect: rec.FirstTryCorrect, Wrong: rec.Wrong,
			})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Timestamp > items[j].Timestamp })
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(items)
	}
}

// traceDeleteHandler – DELETE|POST /trace/delete?id=X
func traceDeleteHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodDelete && r.Method != http.MethodPost {
			http.Error(w, "DELETE or POST only", http.StatusMethodNotAllowed)
			return
		}
		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}
		if strings.ContainsAny(id, "/\\") || strings.Contains(id, "..") {
			http.Error(w, "invalid id", http.StatusBadRequest)
			return
		}
		path := filepath.Join(tracesDir(), id+".json")
		if err := os.Remove(path); err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			log.Printf("[trace delete] %v", err)
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		log.Printf("[trace deleted] %s", id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": id, "status": "deleted"})
	}
}

// callGemini calls Google Generative Language API with the given prompt
func callGemini(apiKey, model, prompt string) (string, error) {
	endpoint := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s",
		url.PathEscape(model), url.QueryEscape(apiKey))

	body := map[string]any{
		"contents": []map[string]any{
			{"role": "user", "parts": []map[string]string{{"text": prompt}}},
		},
	}
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	resp, err := http.Post(endpoint, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("gemini %d: %s", resp.StatusCode, string(respBody))
	}
	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("parse: %w (body: %s)", err, string(respBody))
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("empty response: %s", string(respBody))
	}
	var sb strings.Builder
	for _, p := range result.Candidates[0].Content.Parts {
		sb.WriteString(p.Text)
	}
	return sb.String(), nil
}

// traceAskHandler – POST /trace/ask  (body: {ids: [...], question: "..."})
func traceAskHandler(apiKey, model string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if apiKey == "" {
			http.Error(w, "GEMINI_API_KEY not set in .env", http.StatusInternalServerError)
			return
		}
		var req struct {
			IDs      []string `json:"ids"`
			Question string   `json:"question"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		var recs []TraceRecord
		for _, id := range req.IDs {
			// prevent path traversal
			if strings.ContainsAny(id, "/\\") || strings.Contains(id, "..") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(tracesDir(), id+".json"))
			if err != nil {
				continue
			}
			var rec TraceRecord
			if err := json.Unmarshal(data, &rec); err != nil {
				continue
			}
			recs = append(recs, rec)
		}
		if len(recs) == 0 {
			http.Error(w, "no traces matched the given ids", http.StatusBadRequest)
			return
		}
		bodyJSON, _ := json.MarshalIndent(recs, "", "  ")
		question := strings.TrimSpace(req.Question)
		if question == "" {
			question = "请分析以上单词听写练习记录：薄弱点、常见错误模式（拼写、发音相似、混淆词等），并给出针对性的复习建议。用中文回答，简洁清晰。"
		}
		prompt := fmt.Sprintf(
			"你是一名英语单词听写助教。以下是用户的听写练习记录（JSON 格式），"+
				"每个 word 含 english=正确单词、chinese=中文释义、attempts=用户尝试输入的序列、"+
				"skipped=是否跳过、firstTryOK=是否一遍过、errorCount=错误次数。\n\n"+
				"练习数据：\n%s\n\n用户问题：%s",
			string(bodyJSON), question,
		)
		answer, err := callGemini(apiKey, model, prompt)
		if err != nil {
			log.Printf("[trace ask] %v", err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"answer": answer, "model": model})
	}
}

// ---------------------------------------------------------------------------

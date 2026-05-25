package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// ---------------------------------------------------------------------------
// Google Tasks integration (OAuth2)
//
// Google Tasks are private user data, so an API key is not enough — we need
// OAuth2. We reuse the same OAuth client as Gmail (credentials/gmail_client_secret.json,
// same Google Cloud project) but request the Tasks scope and store the token
// in a separate file so the Gmail authorization is left intact.
// ---------------------------------------------------------------------------

const tasksAPIBase = "https://tasks.googleapis.com/tasks/v1"

func tasksTokenPath() string {
	return filepath.Join(projectRoot, "credentials", "tasks_token.json")
}

func loadTasksOAuth2Config() (*oauth2.Config, error) {
	data, err := os.ReadFile(gmailClientSecretPath())
	if err != nil {
		return nil, fmt.Errorf("read client secret: %w", err)
	}
	var creds struct {
		Installed struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
			AuthURI      string `json:"auth_uri"`
			TokenURI     string `json:"token_uri"`
		} `json:"installed"`
	}
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("parse client secret: %w", err)
	}
	return &oauth2.Config{
		ClientID:     creds.Installed.ClientID,
		ClientSecret: creds.Installed.ClientSecret,
		Endpoint: oauth2.Endpoint{
			AuthURL:  creds.Installed.AuthURI,
			TokenURL: creds.Installed.TokenURI,
		},
		RedirectURL: "http://localhost:8080/tasks/callback",
		Scopes:      []string{"https://www.googleapis.com/auth/tasks"},
	}, nil
}

func loadTasksToken() (*oauth2.Token, error) {
	data, err := os.ReadFile(tasksTokenPath())
	if err != nil {
		return nil, err
	}
	var tok oauth2.Token
	if err := json.Unmarshal(data, &tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

func saveTasksToken(tok *oauth2.Token) error {
	data, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(tasksTokenPath(), data, 0600)
}

// tasksAccessToken returns a fresh access token, refreshing & re-saving if needed.
func tasksAccessToken() (string, error) {
	cfg, err := loadTasksOAuth2Config()
	if err != nil {
		return "", err
	}
	tok, err := loadTasksToken()
	if err != nil {
		return "", fmt.Errorf("not authorized: %w", err)
	}
	ts := cfg.TokenSource(context.Background(), tok)
	newTok, err := ts.Token()
	if err != nil {
		return "", fmt.Errorf("token refresh: %w", err)
	}
	if newTok.AccessToken != tok.AccessToken {
		saveTasksToken(newTok)
	}
	return newTok.AccessToken, nil
}

// tasksAPICall performs an authenticated request against the Tasks API and
// returns the raw response body and HTTP status. A non-nil error means the
// request never completed (transport/auth failure); HTTP errors from Google
// come back as a non-2xx status with the body intact.
func tasksAPICall(method, apiURL string, body io.Reader) ([]byte, int, error) {
	accessToken, err := tasksAccessToken()
	if err != nil {
		return nil, http.StatusUnauthorized, err
	}
	req, err := http.NewRequest(method, apiURL, body)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, nil
}

// GET /tasks/auth → redirect to Google OAuth2 consent for Tasks
func tasksAuthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg, err := loadTasksOAuth2Config()
		if err != nil {
			http.Error(w, "OAuth config error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		authURL := cfg.AuthCodeURL("tasks-state", oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"))
		http.Redirect(w, r, authURL, http.StatusTemporaryRedirect)
	}
}

// GET /tasks/callback?code=xxx → exchange code for token
func tasksCallbackHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "missing code", http.StatusBadRequest)
			return
		}
		cfg, err := loadTasksOAuth2Config()
		if err != nil {
			http.Error(w, "OAuth config error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		tok, err := cfg.Exchange(context.Background(), code)
		if err != nil {
			http.Error(w, "token exchange failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := saveTasksToken(tok); err != nil {
			http.Error(w, "save token failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		log.Println("[tasks] OAuth2 token saved successfully")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#FAF6EC;">
		<div style="text-align:center"><h1>✅ Google Tasks 授权成功</h1><p>可以关闭此窗口，回到 Lexica 刷新任务列表。</p></div></body></html>`)
	}
}

// GET /tasks/status → whether a Tasks token exists
func tasksStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		tok, err := loadTasksToken()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"authorized": err == nil && tok != nil})
	}
}

// passthroughTasksResponse writes the Tasks API status+body straight to the client.
func passthroughTasksResponse(w http.ResponseWriter, body []byte, code int, err error) {
	if err != nil {
		http.Error(w, err.Error(), code)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	w.Write(body)
}

func tasklistOrDefault(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "@default"
	}
	return s
}

// GET /tasks/list?tasklist=@default → tasks in a list (completed included)
func tasksListHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		tasklist := tasklistOrDefault(r.URL.Query().Get("tasklist"))
		apiURL := fmt.Sprintf("%s/lists/%s/tasks?showCompleted=true&showHidden=true&maxResults=100",
			tasksAPIBase, url.PathEscape(tasklist))
		body, code, err := tasksAPICall("GET", apiURL, nil)
		passthroughTasksResponse(w, body, code, err)
	}
}

// POST /tasks/create {tasklist?, title, notes?}
func tasksCreateHandler() http.HandlerFunc {
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
		var req struct {
			Tasklist string `json:"tasklist"`
			Title    string `json:"title"`
			Notes    string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.Title) == "" {
			http.Error(w, "title required", http.StatusBadRequest)
			return
		}
		payload, _ := json.Marshal(map[string]string{"title": req.Title, "notes": req.Notes})
		apiURL := fmt.Sprintf("%s/lists/%s/tasks", tasksAPIBase, url.PathEscape(tasklistOrDefault(req.Tasklist)))
		body, code, err := tasksAPICall("POST", apiURL, bytes.NewReader(payload))
		passthroughTasksResponse(w, body, code, err)
	}
}

// POST /tasks/update {tasklist?, id, title?, notes?, status?}
// status is "needsAction" or "completed"; only provided fields are patched.
func tasksUpdateHandler() http.HandlerFunc {
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
		var req struct {
			Tasklist string  `json:"tasklist"`
			ID       string  `json:"id"`
			Title    *string `json:"title"`
			Notes    *string `json:"notes"`
			Status   *string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.ID) == "" {
			http.Error(w, "id required", http.StatusBadRequest)
			return
		}
		patch := map[string]any{}
		if req.Title != nil {
			patch["title"] = *req.Title
		}
		if req.Notes != nil {
			patch["notes"] = *req.Notes
		}
		if req.Status != nil {
			patch["status"] = *req.Status
			if *req.Status == "needsAction" {
				patch["completed"] = nil // clear the completed timestamp on un-complete
			}
		}
		payload, _ := json.Marshal(patch)
		apiURL := fmt.Sprintf("%s/lists/%s/tasks/%s", tasksAPIBase,
			url.PathEscape(tasklistOrDefault(req.Tasklist)), url.PathEscape(req.ID))
		body, code, err := tasksAPICall("PATCH", apiURL, bytes.NewReader(payload))
		passthroughTasksResponse(w, body, code, err)
	}
}

// POST /tasks/delete {tasklist?, id}
func tasksDeleteHandler() http.HandlerFunc {
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
		var req struct {
			Tasklist string `json:"tasklist"`
			ID       string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.ID) == "" {
			http.Error(w, "id required", http.StatusBadRequest)
			return
		}
		apiURL := fmt.Sprintf("%s/lists/%s/tasks/%s", tasksAPIBase,
			url.PathEscape(tasklistOrDefault(req.Tasklist)), url.PathEscape(req.ID))
		body, code, err := tasksAPICall("DELETE", apiURL, nil)
		if err != nil {
			http.Error(w, err.Error(), code)
			return
		}
		// Tasks delete returns an empty 204 on success
		w.Header().Set("Content-Type", "application/json")
		if code >= 200 && code < 300 {
			json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
			return
		}
		w.WriteHeader(code)
		w.Write(body)
	}
}

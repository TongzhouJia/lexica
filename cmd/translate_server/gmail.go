package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// ---------------------------------------------------------------------------
// Gmail Daily Report Email (OAuth2)
// ---------------------------------------------------------------------------

func gmailTokenPath() string {
	return filepath.Join(projectRoot, "credentials", "gmail_token.json")
}

func gmailClientSecretPath() string {
	return filepath.Join(projectRoot, "credentials", "gmail_client_secret.json")
}

func loadGmailOAuth2Config() (*oauth2.Config, error) {
	data, err := os.ReadFile(gmailClientSecretPath())
	if err != nil {
		return nil, fmt.Errorf("read client secret: %w", err)
	}
	var creds struct {
		Installed struct {
			ClientID     string   `json:"client_id"`
			ClientSecret string   `json:"client_secret"`
			AuthURI      string   `json:"auth_uri"`
			TokenURI     string   `json:"token_uri"`
			RedirectURIs []string `json:"redirect_uris"`
		} `json:"installed"`
	}
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("parse client secret: %w", err)
	}
	redirectURI := "http://localhost:8080/gmail/callback"
	return &oauth2.Config{
		ClientID:     creds.Installed.ClientID,
		ClientSecret: creds.Installed.ClientSecret,
		Endpoint: oauth2.Endpoint{
			AuthURL:  creds.Installed.AuthURI,
			TokenURL: creds.Installed.TokenURI,
		},
		RedirectURL: redirectURI,
		Scopes:      []string{"https://www.googleapis.com/auth/gmail.send"},
	}, nil
}

func loadSavedToken() (*oauth2.Token, error) {
	data, err := os.ReadFile(gmailTokenPath())
	if err != nil {
		return nil, err
	}
	var tok oauth2.Token
	if err := json.Unmarshal(data, &tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

func saveToken(tok *oauth2.Token) error {
	data, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(gmailTokenPath(), data, 0600)
}

// GET /gmail/auth → redirect to Google OAuth2 consent
func gmailAuthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg, err := loadGmailOAuth2Config()
		if err != nil {
			http.Error(w, "OAuth config error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		authURL := cfg.AuthCodeURL("state-token", oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"))
		http.Redirect(w, r, authURL, http.StatusTemporaryRedirect)
	}
}

// GET /gmail/callback?code=xxx → exchange code for token
func gmailCallbackHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "missing code", http.StatusBadRequest)
			return
		}
		cfg, err := loadGmailOAuth2Config()
		if err != nil {
			http.Error(w, "OAuth config error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		tok, err := cfg.Exchange(context.Background(), code)
		if err != nil {
			http.Error(w, "token exchange failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := saveToken(tok); err != nil {
			http.Error(w, "save token failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		log.Println("[gmail] OAuth2 token saved successfully")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#FAF6EC;">
		<div style="text-align:center"><h1>✅ Gmail 授权成功</h1><p>可以关闭此窗口了。</p></div></body></html>`)
	}
}

// GET /gmail/status → check if Gmail token exists and is valid
func gmailStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		tok, err := loadSavedToken()
		authorized := err == nil && tok != nil
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"authorized": authorized})
	}
}

func buildDailyReport(geminiKey, geminiModel string) (string, error) {
	loc := time.FixedZone("UTC+8", 8*60*60)
	today := time.Now().In(loc).Format("2006-01-02")

	// Collect today's activity logs
	logFile := filepath.Join(activityLogDir(), today+".json")
	var logs []ActivityLogEntry
	if data, err := os.ReadFile(logFile); err == nil {
		json.Unmarshal(data, &logs)
	}

	// Collect today's traces
	var todayTraces []TraceRecord
	trDir := tracesDir()
	if entries, err := os.ReadDir(trDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(trDir, e.Name()))
			if err != nil {
				continue
			}
			var rec TraceRecord
			if json.Unmarshal(data, &rec) == nil && strings.HasPrefix(rec.Timestamp, today) {
				todayTraces = append(todayTraces, rec)
			}
		}
	}

	// Collect cleaned words
	pendingFile := filepath.Join(projectRoot, "data", "clean_sync_pending.json")
	var cleanRecords []CleanSyncRecord
	if data, err := os.ReadFile(pendingFile); err == nil {
		json.Unmarshal(data, &cleanRecords)
	}
	var todayCleaned []CleanSyncRecord
	for _, r := range cleanRecords {
		if strings.HasPrefix(r.CleanedAt, today) {
			todayCleaned = append(todayCleaned, r)
		}
	}

	// Study time today
	studyDay := loadStudyDay(today)
	studyTotalMs := totalStudyMs(studyDay)
	studyMinutes := int(studyTotalMs / 60000)

	// Build report content
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("📅 %s 学习日报\n\n", today))

	if studyTotalMs > 0 {
		hours := studyMinutes / 60
		mins := studyMinutes % 60
		if hours > 0 {
			sb.WriteString(fmt.Sprintf("⏱  在线学习时长: %d 小时 %d 分钟（共 %d 段）\n", hours, mins, len(studyDay.Segments)))
		} else {
			sb.WriteString(fmt.Sprintf("⏱  在线学习时长: %d 分钟（共 %d 段）\n", mins, len(studyDay.Segments)))
		}
		// First-last bracket
		if len(studyDay.Segments) > 0 {
			sort.Slice(studyDay.Segments, func(i, j int) bool {
				return studyDay.Segments[i].Start < studyDay.Segments[j].Start
			})
			first := studyDay.Segments[0].Start
			last := studyDay.Segments[len(studyDay.Segments)-1].End
			sb.WriteString(fmt.Sprintf("   首次活跃 %s · 最后活跃 %s\n\n",
				time.UnixMilli(first).In(loc).Format("15:04"),
				time.UnixMilli(last).In(loc).Format("15:04")))
		} else {
			sb.WriteString("\n")
		}
	}

	if len(todayTraces) > 0 {
		totalWords := 0
		correct := 0
		wrong := 0
		for _, t := range todayTraces {
			totalWords += t.Total
			correct += t.FirstTryCorrect
			wrong += t.Wrong
		}
		sb.WriteString(fmt.Sprintf("📝 听写练习: %d 次\n", len(todayTraces)))
		sb.WriteString(fmt.Sprintf("   总计 %d 个单词, 一遍过 %d, 错误 %d\n\n", totalWords, correct, wrong))
	} else {
		sb.WriteString("📝 听写练习: 今日无记录\n\n")
	}

	if len(todayCleaned) > 0 {
		var words []string
		for _, c := range todayCleaned {
			words = append(words, c.Words)
		}
		sb.WriteString(fmt.Sprintf("🧹 学会并清理: %s\n\n", strings.Join(words, ", ")))
	}

	if len(logs) > 0 {
		sb.WriteString(fmt.Sprintf("📋 操作记录: %d 条\n", len(logs)))
		for _, l := range logs {
			sb.WriteString(fmt.Sprintf("   [%s] %s\n", l.Type, l.Summary))
		}
	}

	// If Gemini is available, generate a summary
	if geminiKey != "" && (len(todayTraces) > 0 || len(todayCleaned) > 0) {
		prompt := fmt.Sprintf("你是一名英语学习助手。以下是用户今天的学习数据，请用中文写一段简短鼓励性的总结和明日建议(100字以内):\n\n%s", sb.String())
		if summary, err := callGemini(geminiKey, geminiModel, prompt); err == nil {
			sb.WriteString("\n\n🤖 AI 点评:\n" + summary)
		}
	}

	return sb.String(), nil
}

// sendGmailMessage sends a plain-text UTF-8 email via the Gmail API using
// the locally stored OAuth token. Returns an error if the user has not yet
// authorized Gmail (visit /gmail/auth) or if the API call fails.
func sendGmailMessage(to, subject, body string) error {
	cfg, err := loadGmailOAuth2Config()
	if err != nil {
		return fmt.Errorf("oauth config: %w", err)
	}
	tok, err := loadSavedToken()
	if err != nil {
		return fmt.Errorf("not authorized: %w", err)
	}
	tokenSource := cfg.TokenSource(context.Background(), tok)
	newTok, err := tokenSource.Token()
	if err != nil {
		return fmt.Errorf("token refresh: %w", err)
	}
	if newTok.AccessToken != tok.AccessToken {
		saveToken(newTok)
	}

	msgStr := fmt.Sprintf(
		"To: %s\r\nSubject: =?utf-8?B?%s?=\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\n%s",
		to,
		base64.StdEncoding.EncodeToString([]byte(subject)),
		body,
	)
	raw := base64.URLEncoding.EncodeToString([]byte(msgStr))

	reqBody, _ := json.Marshal(map[string]string{"raw": raw})
	httpReq, _ := http.NewRequest("POST",
		"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
		bytes.NewReader(reqBody))
	httpReq.Header.Set("Authorization", "Bearer "+newTok.AccessToken)
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("gmail send: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("gmail api %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// POST /email/reminder (body ignored)
// Builds and sends a "get back to studying" nag email to the recipient
// configured via the REMINDER_EMAIL env var (single-user app).
func emailReminderHandler() http.HandlerFunc {
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
		to := strings.TrimSpace(os.Getenv("REMINDER_EMAIL"))
		if to == "" {
			http.Error(w, "REMINDER_EMAIL not configured", http.StatusInternalServerError)
			return
		}
		// Drain the body so the client doesn't choke on a half-read request.
		io.Copy(io.Discard, r.Body)
		req := struct{ To string }{To: to}

		loc := time.FixedZone("UTC+8", 8*60*60)
		date := utc8Date(time.Now())
		sd := loadStudyDay(date)
		s := loadStats(date)

		totalMs := totalStudyMs(sd)
		totalMin := int(totalMs / 60000)
		hours := totalMin / 60
		mins := totalMin % 60

		var lastSeg StudySegment
		if len(sd.Segments) > 0 {
			sort.Slice(sd.Segments, func(i, j int) bool {
				return sd.Segments[i].Start < sd.Segments[j].Start
			})
			lastSeg = sd.Segments[len(sd.Segments)-1]
		}

		cleaned := countCleanedWordsToday(date)

		var sb strings.Builder
		sb.WriteString("⏰ 嘿，你已经走神 10 分钟啦！快回来学习 🚀\n\n")
		sb.WriteString(fmt.Sprintf("📅 %s\n\n", date))

		if hours > 0 {
			sb.WriteString(fmt.Sprintf("⏱ 今日累计：%d 小时 %d 分钟\n", hours, mins))
		} else {
			sb.WriteString(fmt.Sprintf("⏱ 今日累计：%d 分钟\n", mins))
		}

		if lastSeg.End > lastSeg.Start {
			lastMin := int((lastSeg.End - lastSeg.Start) / 60000)
			sb.WriteString(fmt.Sprintf("🔥 上一段：%s - %s（%d 分钟）\n",
				time.UnixMilli(lastSeg.Start).In(loc).Format("15:04"),
				time.UnixMilli(lastSeg.End).In(loc).Format("15:04"),
				lastMin,
			))
		}

		sb.WriteString("\n📈 今日干了啥：\n")
		sb.WriteString(fmt.Sprintf("   · 🧹 学会单词 %d 个\n", cleaned))
		sb.WriteString(fmt.Sprintf("   · 🔊 听音频 %d 次\n", s.TTSPlays))
		sb.WriteString(fmt.Sprintf("   · ✍️  听写 %d 个单词（共输入 %d 次）\n", s.DictWords, s.DictInputs))
		sb.WriteString(fmt.Sprintf("   · 👁️  认词 %d 个\n", s.RecogWords))
		sb.WriteString("\n别再摸鱼了！赶紧回来背单词 🎯")

		subject := fmt.Sprintf("⏰ 别摸鱼啦！回来学英语 — %s", date)
		if err := sendGmailMessage(req.To, subject, sb.String()); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		appendActivityLog("reminder", fmt.Sprintf("发送摸鱼提醒到 %s", req.To), nil)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "sent", "to": req.To})
	}
}

// POST /email/send → send today's daily report via Gmail
func emailSendHandler(geminiKey, geminiModel string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			To string `json:"to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.To == "" {
			http.Error(w, "need {\"to\":\"email@example.com\"}", http.StatusBadRequest)
			return
		}

		report, err := buildDailyReport(geminiKey, geminiModel)
		if err != nil {
			http.Error(w, "build report: "+err.Error(), http.StatusInternalServerError)
			return
		}

		loc := time.FixedZone("UTC+8", 8*60*60)
		today := time.Now().In(loc).Format("2006-01-02")
		subject := fmt.Sprintf("📚 英语学习日报 — %s", today)

		if err := sendGmailMessage(req.To, subject, report); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		appendActivityLog("email", fmt.Sprintf("已发送日报到 %s", req.To), nil)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "sent", "to": req.To})
	}
}

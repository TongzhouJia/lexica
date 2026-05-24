package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// ---------------------------------------------------------------------------
// Study Time Tracker
//
// Activity segments are stored one file per UTC+8 calendar day under
// data/translate_server/study_time/YYYY-MM-DD.json. The frontend posts
// segments as {start, end} ms epoch; the backend upserts by start time so
// the same in-progress segment can be extended via repeated heartbeats.
// ---------------------------------------------------------------------------

type StudySegment struct {
	Start int64 `json:"start"` // ms epoch
	End   int64 `json:"end"`   // ms epoch
}

type StudyDay struct {
	Date     string         `json:"date"`
	Segments []StudySegment `json:"segments"`
}

func studyTimeDir() string {
	return filepath.Join(projectRoot, "data", "translate_server", "study_time")
}

func studyTimePath(date string) string {
	return filepath.Join(studyTimeDir(), date+".json")
}

func utc8Date(t time.Time) string {
	loc := time.FixedZone("UTC+8", 8*60*60)
	return t.In(loc).Format("2006-01-02")
}

func utc8DateForMs(ms int64) string {
	return utc8Date(time.UnixMilli(ms))
}

func loadStudyDay(date string) StudyDay {
	day := StudyDay{Date: date}
	data, err := os.ReadFile(studyTimePath(date))
	if err == nil {
		json.Unmarshal(data, &day)
	}
	if day.Date == "" {
		day.Date = date
	}
	return day
}

func saveStudyDay(day StudyDay) error {
	if err := os.MkdirAll(studyTimeDir(), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(day, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(studyTimePath(day.Date), data, 0644)
}

// upsertSegment merges a segment into a StudyDay by Start ms.
// Returns the updated StudyDay.
func upsertSegment(day StudyDay, seg StudySegment) StudyDay {
	for i := range day.Segments {
		if day.Segments[i].Start == seg.Start {
			if seg.End > day.Segments[i].End {
				day.Segments[i].End = seg.End
			}
			return day
		}
	}
	day.Segments = append(day.Segments, seg)
	return day
}

func totalStudyMs(day StudyDay) int64 {
	var total int64
	for _, s := range day.Segments {
		if s.End > s.Start {
			total += s.End - s.Start
		}
	}
	return total
}

// studyTimeSegmentHandler – POST /studytime/segment {start, end}
// Records (or extends) an activity segment. Idempotent on start time.
func studyTimeSegmentHandler() http.HandlerFunc {
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
		var seg StudySegment
		if err := json.NewDecoder(r.Body).Decode(&seg); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if seg.Start <= 0 || seg.End < seg.Start {
			http.Error(w, "invalid segment", http.StatusBadRequest)
			return
		}

		date := utc8DateForMs(seg.Start)
		day := loadStudyDay(date)
		day = upsertSegment(day, seg)
		if err := saveStudyDay(day); err != nil {
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":  "ok",
			"date":    date,
			"totalMs": totalStudyMs(day),
		})
	}
}

// studyTimeTodayHandler – GET /studytime/today
// Returns today's (UTC+8) segments and totals.
func studyTimeTodayHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		date := utc8Date(time.Now())
		day := loadStudyDay(date)
		sort.Slice(day.Segments, func(i, j int) bool {
			return day.Segments[i].Start < day.Segments[j].Start
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"date":     date,
			"segments": day.Segments,
			"totalMs":  totalStudyMs(day),
		})
	}
}

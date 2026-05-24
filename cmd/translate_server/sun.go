package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/kixorz/suncalc"
)

// ---------------------------------------------------------------------------
// Sunrise / sunset computed locally (no API call). Reads SUN_LAT / SUN_LON
// from env (defaults to Beijing). The Google Weather API doesn't cover
// mainland China, so the kixorz/suncalc library handles the math.
// ---------------------------------------------------------------------------

func sunLocation() (lat, lon float64) {
	lat, lon = 39.9042, 116.4074 // Beijing default
	if v := strings.TrimSpace(os.Getenv("SUN_LAT")); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			lat = f
		}
	}
	if v := strings.TrimSpace(os.Getenv("SUN_LON")); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			lon = f
		}
	}
	return
}

// sunTodayHandler – GET /sun/today
// Returns today's sunrise/sunset (UTC+8 calendar) for the configured location
// as ms-epoch values, plus current server time and location for the frontend.
func sunTodayHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		lat, lon := sunLocation()

		loc := time.FixedZone("UTC+8", 8*60*60)
		now := time.Now()
		// Use noon UTC+8 of today as the reference instant so the library
		// returns events for the current UTC+8 calendar day even when the
		// server clock is somewhere near midnight.
		nowLocal := now.In(loc)
		y, m, d := nowLocal.Date()
		noonLocal := time.Date(y, m, d, 12, 0, 0, 0, loc)

		times := suncalc.GetTimes(noonLocal, lat, lon)

		ms := func(name suncalc.DayTimeName) int64 {
			v := times[name].Value
			if v.IsZero() {
				return 0
			}
			return v.UnixMilli()
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"date":             utc8Date(now),
			"nowMs":            now.UnixMilli(),
			"lat":              lat,
			"lon":              lon,
			"dawnMs":           ms(suncalc.Dawn),          // civil twilight starts
			"sunriseMs":        ms(suncalc.Sunrise),       // top of sun touches horizon
			"goldenMorningMs":  ms(suncalc.GoldenHourEnd), // morning golden hour ends
			"solarNoonMs":      ms(suncalc.SolarNoon),     // sun at zenith
			"goldenEveningMs":  ms(suncalc.GoldenHour),    // evening golden hour starts
			"sunsetMs":         ms(suncalc.Sunset),        // sun disappears
			"duskMs":           ms(suncalc.Dusk),          // civil twilight ends
		})
	}
}

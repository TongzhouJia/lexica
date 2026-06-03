# syntax=docker/dockerfile:1

# ---- build stage --------------------------------------------------------
FROM golang:1.25-alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/translate_server ./cmd/translate_server

# ---- runtime stage ------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
ENV TZ=Asia/Shanghai
WORKDIR /app

# Binary (frontend assets under cmd/translate_server/web are embedded via go:embed)
COPY --from=builder /out/translate_server /app/translate_server

# .env / credentials / data are mounted as volumes by docker-compose
EXPOSE 8080
CMD ["/app/translate_server"]

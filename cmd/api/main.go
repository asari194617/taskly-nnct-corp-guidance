package main

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/asari194617/taskly-nnct-corp-guidance/internal/server"
	_ "github.com/go-sql-driver/mysql"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	config, err := server.ConfigFromEnv()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		slog.Error("MYSQL_DSN required")
		os.Exit(1)
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		slog.Error("database configuration invalid")
		os.Exit(1)
	}
	defer db.Close()
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(3 * time.Minute)
	store := server.SQLStore{DB: db}
	app, err := server.New(config, store, nil)
	if err != nil {
		slog.Error("cannot initialize server")
		os.Exit(1)
	}
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}
	srv := &http.Server{Addr: addr, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cleanCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				if err := store.Cleanup(cleanCtx); err != nil {
					slog.Warn("expired session cleanup failed")
				}
				cancel()
			}
		}
	}()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("graceful shutdown incomplete")
		}
	}()
	slog.Info("guidance API listening", "address", addr)
	if err = srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("HTTP server failed", "error", err)
		os.Exit(1)
	}
	<-shutdownDone
}

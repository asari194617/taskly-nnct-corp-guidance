FROM golang:1.27.4-alpine3.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/api ./cmd/api && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/import-guidance ./cmd/import-guidance

FROM alpine:3.24.4
RUN apk add --no-cache ca-certificates && addgroup -g 10001 app && adduser -D -u 10001 -G app app
COPY --from=build /out/api /usr/local/bin/api
COPY --from=build /out/import-guidance /usr/local/bin/import-guidance
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]

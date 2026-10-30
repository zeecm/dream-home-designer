# Build from the repo root: docker build -f apps/api/Dockerfile apps/api
# mirror.gcr.io is Docker Hub's official images without anonymous pull limits.
FROM mirror.gcr.io/library/golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api
ENV ADDR=:8080 DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["/api"]

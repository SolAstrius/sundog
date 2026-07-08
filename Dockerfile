# Multi-stage: build the Vite bundle with Deno, serve dist/ with a tiny Deno static server.
FROM denoland/deno:alpine AS build
WORKDIR /app
COPY package.json deno.json ./
COPY . .
RUN deno install --allow-scripts && deno run -A npm:vite build

FROM denoland/deno:alpine
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY server/ server/
# Warm the jsr dependency cache so startup doesn't fetch.
RUN deno cache server/main.ts
EXPOSE 8080
CMD ["run", "--allow-net", "--allow-read", "--allow-env", "server/main.ts"]

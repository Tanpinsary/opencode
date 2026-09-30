.PHONY: build build-web clean

build:
	bun run --cwd packages/opencode build --single --skip-install --skip-embed-web-ui

build-web:
	bun run --cwd packages/opencode build --single --skip-install

clean:
	rm -rf packages/opencode/dist packages/app/dist

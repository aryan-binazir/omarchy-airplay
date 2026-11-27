.PHONY: test bump tag

test:
	jq -e . manifest.json i18n/en.json > /dev/null
	node --test "tests/*.test.js"

# make bump [LEVEL=minor|major]
bump:
	scripts/release.sh bump $(LEVEL)

# make tag [DRY_RUN=1]
tag:
	scripts/release.sh tag $(if $(DRY_RUN),--dry-run)

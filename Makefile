.PHONY: test bump tag

# /usr/bin/qmltestrunner is Qt 5's on Arch.
QMLTESTRUNNER ?= /usr/lib/qt6/bin/qmltestrunner

test:
	jq -e . manifest.json i18n/en.json > /dev/null
	node --test "tests/*.test.js"
	QT_QPA_PLATFORM=offscreen $(QMLTESTRUNNER) -input tests/tst_service.qml -import tests/qml

# make bump [LEVEL=minor|major]
bump:
	scripts/release.sh bump $(LEVEL)

# make tag [DRY_RUN=1]
tag:
	scripts/release.sh tag $(if $(DRY_RUN),--dry-run)

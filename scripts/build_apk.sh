#!/usr/bin/env bash
# Compila o Estúdio 3D em um APK assinado, sem Gradle:
# aapt2 (recursos) -> javac (Activity) -> d8 (dex) -> zipalign -> apksigner.
# Requisitos: ANDROID_HOME apontando para o SDK e JDK 17 no PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ANDROID_HOME:?defina ANDROID_HOME apontando para o Android SDK}"
BT_VER="34.0.0"
PLATFORM="android-34"
BT="$ANDROID_HOME/build-tools/$BT_VER"
PLAT="$ANDROID_HOME/platforms/$PLATFORM"

if [ ! -x "$BT/aapt2" ] || [ ! -f "$PLAT/android.jar" ]; then
  SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  echo "Instalando build-tools;$BT_VER e platforms;$PLATFORM…"
  yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
  "$SDKMANAGER" "build-tools;$BT_VER" "platforms;$PLATFORM"
fi

test -f web/dist/app.js || { echo "ERRO: web/dist/app.js não existe (gere o bundle antes)"; exit 1; }

rm -rf build
mkdir -p build/assets/dist build/assets/icons build/gen build/classes build/dex apk

# ---- assets do editor web dentro do APK ----
cp web/index.html web/app.css build/assets/
cp web/dist/app.js build/assets/dist/
cp web/icons/*.png build/assets/icons/

# ---- recursos e manifest ----
"$BT/aapt2" compile --dir android/res -o build/res.zip
"$BT/aapt2" link -o build/base.apk \
  -I "$PLAT/android.jar" \
  --manifest android/AndroidManifest.xml \
  -R build/res.zip \
  -A build/assets \
  --java build/gen \
  --auto-add-overlay

# ---- código ----
find android/java build/gen -name "*.java" > build/sources.txt
javac -classpath "$PLAT/android.jar" -encoding UTF-8 -d build/classes @build/sources.txt

java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 29 \
  --lib "$PLAT/android.jar" --output build/dex \
  $(find build/classes -name "*.class")

# ---- empacota, alinha, assina ----
(cd build/dex && zip -q ../base.apk classes.dex)
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk
"$BT/apksigner" sign \
  --ks android/keystore/estudio3d.keystore \
  --ks-pass pass:estudio3d --key-pass pass:estudio3d \
  --ks-key-alias estudio3d \
  --out apk/Estudio3D.apk build/aligned.apk
"$BT/apksigner" verify --print-certs apk/Estudio3D.apk

echo "OK -> apk/Estudio3D.apk"
ls -la apk/

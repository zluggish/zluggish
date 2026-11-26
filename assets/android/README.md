# Zwift first-launch activity

`SetupActivity.java` is the source for `zwift-setup.dex`. The server adds the DEX to the rebuilt APK and supplies the original launcher and renamed expansion filename through activity metadata. The expansion is stored uncompressed, so the activity can read its size and stream it out before starting Zwift.

Regenerate the DEX with JDK 17 and Android SDK build-tools 30.0.3. Use the Android API stubs from Maven Central, artifact `com.google.android:android:4.1.1.4`.

```sh
mkdir -p "$BUILD_DIR/classes" "$BUILD_DIR/dex"
javac --release 8 -classpath "$ANDROID_STUBS" -d "$BUILD_DIR/classes" assets/android/SetupActivity.java
"$ANDROID_BUILD_TOOLS/d8" --min-api 26 --lib "$ANDROID_STUBS" --output "$BUILD_DIR/dex" "$BUILD_DIR"/classes/com/zluggish/zwift/bootstrap/*.class
cp "$BUILD_DIR/dex/classes.dex" assets/android/zwift-setup.dex
```

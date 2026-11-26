package com.zluggish.zwift.bootstrap;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.os.Bundle;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

public final class SetupActivity extends Activity {
    private static final String ASSET = "zluggish/expansion.obb";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final TextView status = new TextView(this);
        status.setText("Preparing Zwift for Zluggish. This may take a few minutes.");
        status.setPadding(32, 32, 32, 32);
        setContentView(status);

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    PackageManager packages = getPackageManager();
                    Bundle metadata = packages.getActivityInfo(getComponentName(), PackageManager.GET_META_DATA).metaData;
                    long updateTime = packages.getPackageInfo(getPackageName(), 0).lastUpdateTime;
                    prepareExpansion(SetupActivity.this, metadata.getString("zluggish.expansion"), updateTime);
                    final String launcher = metadata.getString("zluggish.launcher");
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (!isFinishing()) {
                                Intent launch = new Intent(Intent.ACTION_MAIN);
                                launch.addCategory(Intent.CATEGORY_LAUNCHER);
                                launch.setClassName(getPackageName(), launcher);
                                try {
                                    startActivity(launch);
                                    finish();
                                } catch (RuntimeException error) {
                                    status.setText("Could not start Zwift.\n" + error.getMessage());
                                }
                            }
                        }
                    });
                } catch (final Exception error) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            status.setText("Could not prepare Zwift. Check available storage and reopen the app.\n"
                                    + error.getMessage());
                        }
                    });
                }
            }
        }, "zluggish-expansion").start();
    }

    private static synchronized void prepareExpansion(SetupActivity activity, String filename, long updateTime)
            throws IOException {
        File folder = activity.getObbDir();
        if (folder == null || (!folder.isDirectory() && !folder.mkdirs())) {
            throw new IOException("Android could not create the expansion folder.");
        }

        File expansion = new File(folder, filename);
        SharedPreferences setup = activity.getSharedPreferences("zluggish_setup", MODE_PRIVATE);
        long size;
        AssetFileDescriptor asset = activity.getAssets().openFd(ASSET);
        try {
            size = asset.getLength();
        } finally {
            asset.close();
        }

        if (expansion.isFile() && expansion.length() == size && setup.getLong(filename, -1) == updateTime) {
            return;
        }

        File partial = new File(folder, filename + ".part");
        try {
            try (InputStream source = activity.getAssets().open(ASSET);
                    FileOutputStream destination = new FileOutputStream(partial)) {
                byte[] buffer = new byte[1024 * 1024];
                int length;
                while ((length = source.read(buffer)) != -1) {
                    destination.write(buffer, 0, length);
                }
                destination.getFD().sync();
            }

            if (partial.length() != size || !partial.renameTo(expansion)) {
                throw new IOException("Android could not save the full expansion file.");
            }
            setup.edit().putLong(filename, updateTime).apply();
        } finally {
            if (partial.exists()) {
                partial.delete();
            }
        }
    }
}

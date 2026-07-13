package br.nicolas.estudio3d;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;

public class MainActivity extends Activity {

    private static final int REQ_FILE = 41;
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);
        webView.setKeepScreenOn(true);
        webView.setBackgroundColor(0xFF0F1318);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);

        webView.addJavascriptInterface(new Bridge(), "EstudioBridge");
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(intent, "Importar arquivo"), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        // evita sair do app por um toque acidental no gesto de voltar
        moveTaskToBack(true);
    }

    private Uri lastSavedUri;
    private String lastSavedMime = "application/octet-stream";
    private String lastSavedName = "";

    private class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, type);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Korx3D");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("sem acesso a Downloads");
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    os.write(bytes);
                    os.flush();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
                lastSavedUri = uri;
                lastSavedMime = type;
                lastSavedName = name;
                toast("Salvo em Download/Korx3D: " + name);
            } catch (Exception e) {
                // plano B: pasta do próprio app (sempre gravável)
                try {
                    byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                    java.io.File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
                    java.io.File f = new java.io.File(dir, name);
                    try (java.io.FileOutputStream fos = new java.io.FileOutputStream(f)) {
                        fos.write(bytes);
                    }
                    lastSavedUri = Uri.fromFile(f);
                    lastSavedMime = type;
                    lastSavedName = name;
                    toast("Salvo em: " + f.getAbsolutePath());
                } catch (Exception e2) {
                    toast("Erro ao salvar: " + e.getMessage());
                }
            }
        }

        // Compartilha o último arquivo exportado — permite mandar direto para
        // Bambu Handy, Creality Print/Cloud, e-mail, Drive etc.
        @JavascriptInterface
        public void shareLast() {
            if (lastSavedUri == null) { toast("Exporte um arquivo primeiro"); return; }
            try {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(lastSavedMime);
                send.putExtra(Intent.EXTRA_STREAM, lastSavedUri);
                send.putExtra(Intent.EXTRA_SUBJECT, lastSavedName);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, "Enviar " + lastSavedName + " para…");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
            } catch (Exception e) {
                toast("Erro ao compartilhar: " + e.getMessage());
            }
        }

        private void toast(final String msg) {
            runOnUiThread(() ->
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
        }
    }
}

package io.github.choiy4432.dure;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.animation.LinearInterpolator;

import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.androidbrowserhelper.trusted.SessionStore;
import com.google.androidbrowserhelper.trusted.SharedPreferencesTokenStore;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/**
 * 두레 앱의 시작 화면 — 보이는 화면에서 TWA 를 연다(androidbrowserhelper 의 투명한 LauncherActivity 는 안드로이드 17 에서 아무것도 안 했다, 실측).
 * - VIEW 인텐트(크롬의 [두레 앱으로 열기] · 알림 누름)로 https *.ts.net 주소가 오면 기억하고 그 주소로 연다.
 * - 아니면 기억한 PC 의 origin + /mobile.html 로. 기억한 게 없으면 '처음 쓰기' 안내.
 * - 여는 주소에는 앱 판(?app=)을 싣는다 — 웹이 앱 안인 것과 앱 판을 안다.
 * PC 가 꺼져 있어도 곧바로 연다 — 크롬이 앱 인정을 기억해 주소창 없이 웹의 'PC 에 연결하고 있어요'가 뜬다(실측).
 * 수명은 LauncherActivity 와 같은 꼴: TWA 를 띄운 뒤 사용자가 돌아오면(onRestart) 끝낸다.
 */
public class StartActivity extends Activity {
    private static final String PREFS = "dure";
    private static final String KEY_URL = "url";
    private static final String STATE_LAUNCHED = "browserWasLaunched";

    /** 살아 있는 시작 화면 수 — TWA 가 떠 있는데 주소 없이 또 열리면(아이콘) 새로 띄우지 않고 떠 있는 쪽을 보인다 */
    private static int alive;

    private boolean counted;
    private boolean firstRun;
    private boolean browserWasLaunched;
    private TwaLauncher launcher;
    private ObjectAnimator spin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // 안드로이드 15 이상은 늘 화면 끝까지 그린다 — 낮은 판도 같게 그리고, 막대 밑 여백은 insets 로 둔다
        WindowCompat.enableEdgeToEdge(getWindow());
        if (restartInNewTask()) {
            finish();
            return;
        }
        alive++;
        counted = true;
        if (alive > 1 && getIntent().getData() == null) {
            finish();
            return;
        }
        if (state != null && state.getBoolean(STATE_LAUNCHED)) {
            // TWA 를 띄운 뒤 이 화면이 뒤에서 죽었다가, 사용자가 TWA 를 닫아 여기로 왔다
            finish();
            return;
        }
        String url = urlToOpen();
        if (url == null) {
            showFirstRun();
            return;
        }
        showStart();
        launch(url);
    }

    /** 열 주소 — 받은 주소(기억해 둔다) · 아니면 기억한 PC · 그것도 없으면 null. 받은 주소가 맞지 않으면 버리고 기억한 것을 덮지 않는다 */
    private String urlToOpen() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        Uri data = getIntent().getData();
        String received = data == null ? null : LaunchUrls.acceptedUrl(data.toString());
        if (received != null) {
            prefs.edit().putString(KEY_URL, received).apply();
            return LaunchUrls.launchUrl(received, BuildConfig.VERSION_CODE);
        }
        String origin = savedOrigin();
        return origin == null ? null : LaunchUrls.launchUrl(origin + "/mobile.html", BuildConfig.VERSION_CODE);
    }

    private String savedOrigin() {
        return LaunchUrls.originOf(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null));
    }

    private void launch(String url) {
        int bg = getColor(R.color.bg);
        TrustedWebActivityIntentBuilder builder = new TrustedWebActivityIntentBuilder(Uri.parse(url))
                .setDefaultColorSchemeParams(new CustomTabColorSchemeParams.Builder()
                        .setToolbarColor(bg)
                        .setNavigationBarColor(bg)
                        .build());
        // LauncherActivity 와 같게 — 작업(task)마다 세션, 크롬 토큰은 앱 저장소에(DelegationService 가 크롬인지 이것으로 본다)
        launcher = new TwaLauncher(this, null, SessionStore.makeSessionId(getTaskId()), new SharedPreferencesTokenStore(this));
        launcher.launch(builder, null, null, () -> browserWasLaunched = true, TwaLauncher.CCT_FALLBACK_STRATEGY);
    }

    /** 웹의 'PC 에 연결하고 있어요'와 같은 모습 — 가운데 로고, 아래에 회전 + 글 */
    private void showStart() {
        setContentView(R.layout.start);
        spin = ObjectAnimator.ofFloat(findViewById(R.id.spinner), View.ROTATION, 0f, 360f);
        spin.setDuration(900);
        spin.setRepeatCount(ValueAnimator.INFINITE);
        spin.setInterpolator(new LinearInterpolator());
        spin.start(); // 애니메이션을 끈 기기에서는 돌지 않는다(Animator 가 따른다)
    }

    /** 처음 쓰기 — PC 두레의 QR 로 연 크롬 화면에서 [두레 앱으로 열기]를 누르라고. 위·아래는 상태·탐색 막대만큼 띄운다 */
    private void showFirstRun() {
        firstRun = true;
        setContentView(R.layout.first_run);
        View body = findViewById(R.id.first_run_body);
        int left = body.getPaddingLeft();
        int top = body.getPaddingTop();
        int right = body.getPaddingRight();
        int bottom = body.getPaddingBottom();
        ViewCompat.setOnApplyWindowInsetsListener(body, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + bars.bottom);
            return insets;
        });
    }

    /** 다른 앱의 작업(task) 안에서 열렸으면 우리 작업으로 다시 연다 — 최근 앱에 두레가 하나만 보이게(LauncherActivity 와 같다) */
    private boolean restartInNewTask() {
        int flags = getIntent().getFlags();
        boolean newTask = (flags & Intent.FLAG_ACTIVITY_NEW_TASK) != 0;
        boolean newDocument = (flags & Intent.FLAG_ACTIVITY_NEW_DOCUMENT) != 0;
        if (newTask && !newDocument) return false;
        Intent again = new Intent(getIntent());
        again.setFlags((flags | Intent.FLAG_ACTIVITY_NEW_TASK) & ~Intent.FLAG_ACTIVITY_NEW_DOCUMENT);
        startActivity(again);
        return true;
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        // TWA 에서 돌아왔으면 끝낸다. '처음 쓰기' 동안 다른 시작 화면이 주소를 받아 앱을 열었다가 닫혔어도 이 안내는 끝낸다
        if (browserWasLaunched || (firstRun && savedOrigin() != null)) finish();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putBoolean(STATE_LAUNCHED, browserWasLaunched);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (counted) alive--;
        if (spin != null) spin.cancel();
        if (launcher != null) launcher.destroy();
    }
}

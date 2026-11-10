package io.github.choiy4432.dure;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.LinearInterpolator;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsService;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.androidbrowserhelper.trusted.ChromeLegacyUtils;
import com.google.androidbrowserhelper.trusted.SessionStore;
import com.google.androidbrowserhelper.trusted.SharedPreferencesTokenStore;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

import java.util.List;

/**
 * 두레 앱의 시작 화면 — 보이는 화면에서 TWA 를 연다(androidbrowserhelper 의 투명한 LauncherActivity 는 안드로이드 17 에서 아무것도 안 했다, 실측).
 * 무엇을 할지는 LaunchUrls.decide 가 정한다(순수 Java · JUnit):
 * - VIEW 인텐트(크롬의 [두레 앱으로 열기] · 알림 누름)로 https *.ts.net 주소가 오면 — 기억한 PC 와 같으면 그냥 그 주소로,
 *   처음이면 '이 PC 와 이을까요?'(잇기 = 그 origin 을 기억하고 그 주소로 · 취소 = 아무것도 기억하지 않고 처음 쓰기), 다른 PC 면 '다른 PC 로 바꿀까요?' 를 묻는다.
 * - 아니면 기억한 PC 의 origin + /mobile.html 로. 기억한 게 없으면 '처음 쓰기' 안내.
 * - 여는 주소에는 앱 판(?app=)을 싣는다 — 웹이 앱 안인 것과 앱 판을 안다.
 * - TWA 는 크롬으로 연다(TwaProvider — 짝 쿠키가 크롬 프로필에 있다. 기본 브라우저가 삼성 인터넷·엣지여도). 크롬이 TWA 를 못 열 때만 androidbrowserhelper 가 고른다.
 * PC 가 꺼져 있어도 곧바로 연다 — 크롬이 앱 인정을 기억해 주소창 없이 웹의 'PC 에 연결하고 있어요'가 뜬다(실측).
 * 수명은 LauncherActivity 와 같은 꼴: TWA 를 띄운 뒤 사용자가 돌아오면(onRestart) 끝낸다. 살아 있는 동안 온 새 주소는 onNewIntent 가 같은 길로 다룬다.
 */
public class StartActivity extends Activity {
    private static final String PREFS = "dure";
    /** 기억한 PC 의 origin(예전 판은 전체 주소를 적었다 — decide 가 origin 으로 읽는다) */
    private static final String KEY_URL = "url";
    private static final String STATE_LAUNCHED = "browserWasLaunched";
    private static final String STATE_RECEIVED = "received";
    /** 웹 .connecting 의 로고 = min(36vw, 160px) */
    private static final float LOGO_WIDTH_RATIO = 0.36f;
    private static final float LOGO_MAX_DP = 160f;

    /** 살아 있는 시작 화면 수 — TWA 가 떠 있는데 주소 없이 또 열리면(아이콘) 새로 띄우지 않고 떠 있는 쪽을 보인다 */
    private static int alive;

    private boolean counted;
    private boolean firstRun;
    private boolean browserWasLaunched;
    /**
     * onNewIntent 가 이 화면을 다시 썼다 — 멈춰 있던 화면에 새 주소가 오면 안드로이드 9 이하는 onNewIntent 가 onRestart 보다 먼저 온다.
     * 그때 onRestart 가 방금 연 것을 끝내지 않게 한 번 막는다(onResume 에서 지운다 — 10 이상은 onRestart 가 먼저라 상관없다)
     */
    private boolean reused;
    private boolean visible;
    /** 지금 다루는 받은 주소(VIEW 인텐트의 주소 — onNewIntent 가 바꾼다). 화면이 다시 만들어져도 이어지게 저장한다 */
    private String received;
    private int screen;
    /** 고리 + 'PC 에 연결하고 있어요' 줄 */
    private View line;
    private ObjectAnimator spin;
    private AlertDialog ask;
    private TwaLauncher launcher;

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
        received = state != null ? state.getString(STATE_RECEIVED) : getIntent().getDataString();
        route();
    }

    /**
     * 살아 있는 동안 새 주소가 왔다(이 화면이 맨 위일 때 SINGLE_TOP 으로 — 예: '처음 쓰기'·시작 화면이 떠 있는 채 [두레 앱으로 열기]·알림 누름).
     * 처음 열 때와 같은 길(decide)로 다룬다 — 열면 그 주소(#agent= 깊은 링크 그대로)로 TWA 를 띄운다.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() == null) return; // 주소 없음(아이콘) — 보이던 것 그대로
        setIntent(intent);
        if (isFinishing()) {
            // 안드로이드 10 이상은 멈춰 있던 화면에 onRestart(→ TWA 에서 돌아왔다고 끝냄) 다음에 onNewIntent 가 온다 — 새 시작 화면이 받게 다시 보낸다
            Intent again = new Intent(intent);
            again.setFlags(intent.getFlags() & ~(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP));
            startActivity(again);
            return;
        }
        reused = true;
        browserWasLaunched = false; // 새로 연다 — 이 화면이 맨 위였으니 예전 TWA 는 위에 없다
        received = intent.getDataString();
        route();
    }

    private void route() {
        dismissAsk();
        LaunchUrls.Decision d = LaunchUrls.decide(received, saved(), BuildConfig.VERSION_CODE);
        switch (d.kind) {
            case FIRST_RUN:
                showFirstRun();
                break;
            case CONFIRM:
                askSwitch(d);
                break;
            default:
                open(d);
        }
    }

    private void open(LaunchUrls.Decision d) {
        if (d.save != null) prefs().edit().putString(KEY_URL, d.save).apply();
        showStart(true);
        launch(d.url);
    }

    /** 기억한 PC 와 다른 PC 의 주소 — 바꿀지 묻는다(*.ts.net 이라도 Funnel 로 공개된 남의 주소일 수 있다). 묻는 동안은 로고만, 연결은 아직 */
    private void askSwitch(LaunchUrls.Decision d) {
        boolean first = d.keep == null; // 기억한 PC 가 없는 첫 주소 — 거절하면 아무것도 기억하지 않는다
        showStart(false);
        ask = new AlertDialog.Builder(this, R.style.Theme_Dure_Dialog)
                .setTitle(first ? R.string.first_ask_title : R.string.switch_title)
                .setMessage(d.host)
                .setPositiveButton(first ? R.string.first_ask_connect : R.string.switch_change, (dialog, which) -> open(d.change))
                .setNegativeButton(first ? R.string.first_ask_cancel : R.string.switch_keep, (dialog, which) -> keep(d.keep))
                .setOnCancelListener(dialog -> keep(d.keep)) // 뒤로 = 그대로(바꾸지 않는다)
                .create();
        ask.setCanceledOnTouchOutside(false);
        ask.show();
    }

    /** [그대로] — 늘 하던 대로(아이콘으로 연 것과 같다): 다른 시작 화면이 이미 앱을 띄워 두었으면 그쪽을 보이고, 아니면 기억한 PC 를 연다 */
    private void keep(LaunchUrls.Decision d) {
        if (d == null) showFirstRun(); // 첫 확인을 거절 — 저장 없이 처음 쓰기 화면
        else if (alive > 1) finish();
        else open(d);
    }

    private void dismissAsk() {
        if (ask != null && ask.isShowing()) ask.dismiss(); // dismiss 는 cancel 알림을 부르지 않는다
        ask = null;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private String saved() {
        return prefs().getString(KEY_URL, null);
    }

    private void launch(String url) {
        int bg = getColor(R.color.bg);
        TrustedWebActivityIntentBuilder builder = new TrustedWebActivityIntentBuilder(Uri.parse(url))
                .setDefaultColorSchemeParams(new CustomTabColorSchemeParams.Builder()
                        .setToolbarColor(bg)
                        .setNavigationBarColor(bg)
                        .build());
        // LauncherActivity 와 같게 — 작업(task)마다 세션, 크롬 토큰은 앱 저장소에(DelegationService 가 크롬인지 이것으로 본다).
        // 다시 열 때(onNewIntent)는 같은 것을 쓴다 — 세션이 있으면 곧바로, 아직 잇는 중이면 기다리던 것을 새 주소로 바꾼다
        // 브라우저는 크롬으로 못 박는다(짝 쿠키가 크롬 프로필에 있다 — TwaProvider). 크롬이 TWA 를 못 열면 null(androidbrowserhelper 가 고른다)
        if (launcher == null) {
            launcher = new TwaLauncher(this, provider(), SessionStore.makeSessionId(getTaskId()), new SharedPreferencesTokenStore(this));
        }
        launcher.launch(builder, null, null, () -> browserWasLaunched = true, TwaLauncher.CCT_FALLBACK_STRATEGY);
    }

    /**
     * TWA 를 띄울 브라우저 — 크롬의 CustomTabsService 를 찾아(매니페스트 queries 가 보이게 한다) TWA 갈래가 있거나 TWA 를 아는 옛 크롬(72~74)이면 크롬.
     * 아니면 null(androidbrowserhelper 의 TwaProviderPicker 가 고른다 — 같은 규칙으로 기본 브라우저부터)
     */
    private String provider() {
        PackageManager pm = getPackageManager();
        Intent query = new Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION).setPackage(TwaProvider.CHROME);
        List<ResolveInfo> services = pm.queryIntentServices(query, PackageManager.GET_RESOLVED_FILTER);
        boolean twa = false;
        for (ResolveInfo s : services) {
            if (s.filter != null && TwaProvider.hasTwaCategory(s.filter.categoriesIterator())) twa = true;
        }
        if (!twa && !services.isEmpty()) twa = ChromeLegacyUtils.supportsTrustedWebActivities(pm, TwaProvider.CHROME);
        return TwaProvider.choose(!services.isEmpty(), twa);
    }

    /**
     * 웹의 'PC 에 연결하고 있어요'(offline.html .connecting)와 같은 모습 — connecting 이 false 면 로고만(묻는 동안).
     * 웹은 TWA 의 웹 화면(상태 막대와 탐색 막대 사이 — 시험 앱 화면에서 확인) 한가운데에 로고를 둔다 → 같은 칸을 막대만큼의 바깥 여백으로 만든다.
     */
    private void showStart(boolean connecting) {
        firstRun = false;
        if (screen != R.layout.start) {
            screen = R.layout.start;
            setContentView(R.layout.start);
            View root = findViewById(R.id.start_root);
            ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
                lp.setMargins(bars.left, bars.top, bars.right, bars.bottom);
                v.setLayoutParams(lp);
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(root);
            View logo = findViewById(R.id.logo);
            ViewGroup.LayoutParams size = logo.getLayoutParams();
            float dp = Math.min(LOGO_WIDTH_RATIO * getResources().getConfiguration().screenWidthDp, LOGO_MAX_DP);
            size.width = size.height = Math.round(dp * getResources().getDisplayMetrics().density);
            logo.setLayoutParams(size);
            line = findViewById(R.id.connecting);
            spin = ObjectAnimator.ofFloat(findViewById(R.id.spinner), View.ROTATION, 0f, 360f);
            spin.setDuration(900);
            spin.setRepeatCount(ValueAnimator.INFINITE);
            spin.setInterpolator(new LinearInterpolator());
        }
        line.setVisibility(connecting ? View.VISIBLE : View.INVISIBLE);
        updateSpin();
    }

    /** 처음 쓰기 — PC 두레의 QR 로 연 크롬 화면에서 [두레 앱으로 열기]를 누르라고. 위·아래는 상태·탐색 막대만큼 띄운다 */
    private void showFirstRun() {
        firstRun = true;
        if (screen == R.layout.first_run) return;
        screen = R.layout.first_run;
        stopSpin();
        setContentView(R.layout.first_run);
        addSteps();
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
        ViewCompat.requestApplyInsets(body);
    }

    /** 처음 쓰기의 번호 줄 — first_steps 의 순서대로 한 줄 꼴(first_run_step.xml)을 채운다. 읽어 주는 프로그램은 번호와 함께 읽는다(번호 동그라미는 건너뛴다) */
    private void addSteps() {
        LinearLayout steps = findViewById(R.id.first_run_steps);
        LayoutInflater inflater = LayoutInflater.from(this);
        String[] texts = getResources().getStringArray(R.array.first_steps);
        for (int i = 0; i < texts.length; i++) {
            View row = inflater.inflate(R.layout.first_run_step, steps, false);
            String no = Integer.toString(i + 1);
            TextView badge = row.findViewById(R.id.step_no);
            badge.setText(no);
            TextView text = row.findViewById(R.id.step_text);
            text.setText(texts[i]);
            text.setContentDescription(no + ". " + texts[i]);
            steps.addView(row);
        }
    }

    /** 고리는 보이는 동안만 돈다 — TWA 가 위에 있거나 앱이 뒤로 가면(onStop) 멈춘다(애니메이션을 끈 기기에서는 Animator 가 따라 돌지 않는다) */
    private void updateSpin() {
        if (spin == null) return;
        if (!visible || isFinishing() || line.getVisibility() != View.VISIBLE) {
            spin.pause();
        } else if (spin.isPaused()) {
            spin.resume();
        } else if (!spin.isStarted()) {
            spin.start();
        }
    }

    private void stopSpin() {
        if (spin != null) spin.cancel();
        spin = null;
        line = null;
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
    protected void onStart() {
        super.onStart();
        visible = true;
        updateSpin();
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        if (reused) return; // 방금 onNewIntent 가 새로 열었다(안드로이드 9 이하의 순서)
        // TWA 에서 돌아왔으면 끝낸다. '처음 쓰기' 동안 다른 시작 화면이 주소를 받아 앱을 열었다가 닫혔어도 이 안내는 끝낸다
        if (browserWasLaunched || (firstRun && LaunchUrls.acceptedOrigin(saved()) != null)) finish();
    }

    @Override
    protected void onResume() {
        super.onResume();
        reused = false;
    }

    @Override
    protected void onStop() {
        super.onStop();
        visible = false;
        updateSpin();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putBoolean(STATE_LAUNCHED, browserWasLaunched);
        out.putString(STATE_RECEIVED, received);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (counted) alive--;
        dismissAsk();
        stopSpin();
        if (launcher != null) launcher.destroy();
    }
}

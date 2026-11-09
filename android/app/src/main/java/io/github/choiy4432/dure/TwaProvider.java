package io.github.choiy4432.dure;

import java.util.Iterator;

/**
 * TWA 를 띄울 브라우저 — 크롬(com.android.chrome)으로 못 박는다. 순수 Java 라 기기 없이 JUnit 으로 시험한다(TwaProviderTest).
 * 짝(쿠키)은 크롬 프로필에 있다(PC 두레의 QR 로 연 크롬 화면에서 [두레 앱으로 열기]) — androidbrowserhelper 에 맡기면(provider null)
 * 기본 브라우저부터 고르니, 삼성 인터넷·엣지가 기본인 휴대폰에선 짝이 없는 다른 프로필로 열린다.
 * 크롬이 없거나(지움·꺼 둠) TWA 를 못 열면 null — 그때는 androidbrowserhelper 가 고르게 둔다(아예 안 열리는 것보다 낫다).
 */
final class TwaProvider {
    static final String CHROME = "com.android.chrome";
    /** CustomTabsService 의 갈래(category) — 이걸 내건 브라우저는 TWA 를 연다(androidx.browser CustomTabsService.TRUSTED_WEB_ACTIVITY_CATEGORY) */
    static final String TWA_CATEGORY = "androidx.browser.trusted.category.TrustedWebActivities";

    private TwaProvider() {}

    /**
     * 크롬의 CustomTabsService 하나의 갈래들 — TWA 갈래가 있으면 true.
     * (크롬 72~74 는 TWA 를 열지만 갈래를 아직 안 냈다 — 그건 androidbrowserhelper 의 ChromeLegacyUtils 로 따로 본다)
     */
    static boolean hasTwaCategory(Iterator<String> categories) {
        if (categories == null) return false;
        while (categories.hasNext()) {
            if (TWA_CATEGORY.equals(categories.next())) return true;
        }
        return false;
    }

    /**
     * 열 브라우저 — chromeService: 크롬의 CustomTabsService 가 보이나(깔려 있고 켜져 있음) · chromeTwa: 크롬이 TWA 를 여나.
     * 둘 다면 크롬, 아니면 null(androidbrowserhelper 가 고른다)
     */
    static String choose(boolean chromeService, boolean chromeTwa) {
        return chromeService && chromeTwa ? CHROME : null;
    }
}

package io.github.choiy4432.dure;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

/** TWA 를 띄울 브라우저 — 크롬이 TWA 를 열면 크롬으로 못 박고, 아니면 null(androidbrowserhelper 가 고른다) */
public class TwaProviderTest {
    @Test
    public void pinsChromeWhenItOpensTwa() {
        assertEquals("com.android.chrome", TwaProvider.choose(true, true));
    }

    @Test
    public void fallsBackWhenChromeMissingOrNoTwa() {
        // 크롬이 없거나 꺼 둠(삼성 인터넷만 있는 휴대폰 등) — 서비스가 안 보인다
        assertNull(TwaProvider.choose(false, false));
        assertNull(TwaProvider.choose(false, true));
        // 크롬은 있지만 TWA 를 못 연다(아주 옛 크롬 — Custom Tabs 만)
        assertNull(TwaProvider.choose(true, false));
    }

    @Test
    public void twaCategoryMatchesAndroidx() {
        // 글을 옮겨 적었다 — androidx.browser 의 값과 같아야 한다(컴파일 때 박히는 상수라 기기 없이 읽힌다)
        assertEquals(androidx.browser.customtabs.CustomTabsService.TRUSTED_WEB_ACTIVITY_CATEGORY, TwaProvider.TWA_CATEGORY);
    }

    @Test
    public void twaCategory() {
        assertTrue(TwaProvider.hasTwaCategory(Arrays.asList(
                "androidx.browser.customtabs.category.NavBarColorCustomization",
                "androidx.browser.trusted.category.TrustedWebActivities").iterator()));
        assertFalse(TwaProvider.hasTwaCategory(Arrays.asList(
                "androidx.browser.customtabs.category.ColorSchemeCustomization").iterator()));
        assertFalse(TwaProvider.hasTwaCategory(Collections.<String>emptyIterator()));
        assertFalse(TwaProvider.hasTwaCategory(null));
        // 비슷한 이름은 아니다
        assertFalse(TwaProvider.hasTwaCategory(Collections.singletonList(
                "androidx.browser.trusted.category.TrustedWebActivitiesX").iterator()));
    }
}

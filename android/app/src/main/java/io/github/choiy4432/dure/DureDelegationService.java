package io.github.choiy4432.dure;

import android.annotation.SuppressLint;
import android.app.Notification;

import androidx.annotation.NonNull;

import com.google.androidbrowserhelper.trusted.DelegationService;

/**
 * 크롬이 넘긴 웹 알림을 앱이 올린다.
 * - 크롬은 위임한 알림에도 보조 글(subText = 'pc.tailnet.ts.net:47615')을 채운다 → 알림 머리에 주소 꼬리가 붙었다(실측). 올리기 직전에 지운다.
 * - 채널 이름은 크롬이 넘기는 '일반' 대신 늘 '두레 알림'.
 * - 팝업(heads-up)은 매니페스트의 USE_HIGH_PRI_NOTIFICATIONS 로 — androidbrowserhelper 가 '_channel_id_high_pri' 채널을 HIGH 로 만들고 옛 '_channel_id' 채널을 지운다.
 *   androidx 기본 길은 알릴 때마다 채널을 IMPORTANCE_DEFAULT 로 다시 만들어, 먼저 HIGH 로 만들어 둔 채널도 낮춰 버렸다(실측 — 원래 4 → 3)
 */
// MissingPermission: super(DelegationService)가 알림이 켜졌는지(권한 포함)를 먼저 보고, 꺼졌으면 올리지 않고 false 를 준다
public class DureDelegationService extends DelegationService {
    @Override
    @SuppressLint("MissingPermission")
    public boolean onNotifyNotificationWithChannel(@NonNull String platformTag, int platformId,
            @NonNull Notification notification, @NonNull String channelName) {
        if (notification.extras != null) notification.extras.remove(Notification.EXTRA_SUB_TEXT);
        return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channel());
    }

    /** 크롬이 알림이 켜졌는지 물을 때도 같은 채널을 본다(사용자가 '두레 알림'을 끄면 꺼진 것으로) */
    @Override
    @SuppressLint("MissingPermission")
    public boolean onAreNotificationsEnabled(@NonNull String channelName) {
        return super.onAreNotificationsEnabled(channel());
    }

    private String channel() {
        return getString(R.string.notification_channel);
    }
}

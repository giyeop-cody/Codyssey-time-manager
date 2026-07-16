package kr.codyssey.attendance;

import com.getcapacitor.Plugin;

import kr.codyssey.attendance.plugin.StoragePlugin;
import kr.codyssey.attendance.plugin.AlarmPlugin;
import kr.codyssey.attendance.plugin.NotificationPlugin;
import kr.codyssey.attendance.plugin.NetworkPlugin;

import java.util.Arrays;
import java.util.List;

public class CodysseyPlugin {

    public static List<Class<? extends Plugin>> getPlugins() {
        return Arrays.asList(
                StoragePlugin.class,
                AlarmPlugin.class,
                NotificationPlugin.class,
                NetworkPlugin.class
        );
    }
}
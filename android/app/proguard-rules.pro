# Capacitor JS 인터페이스 보호
-keep class com.getcapacitor.** { *; }
-keepclasseswithmembers class * {
    @com.getcapacitor.annotation.CapacitorPlugin <init>(...);
}
-keepclasseswithmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
}

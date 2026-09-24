# kotlinx.serialization: conserva los serializadores generados de los DTO.
-keepattributes *Annotation*, InnerClasses, Signature, Exceptions
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.tiecoms.app.**$$serializer { *; }
-keepclassmembers class com.tiecoms.app.** { *** Companion; }
-keepclasseswithmembers class com.tiecoms.app.** { kotlinx.serialization.KSerializer serializer(...); }
-keepclassmembers @kotlinx.serialization.Serializable class com.tiecoms.app.** { <fields>; }

# OkHttp trae sus propias reglas; estas silencian avisos de plataformas opcionales.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

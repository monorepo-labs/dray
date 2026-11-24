package com.yogesh.dray.wire

import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.decodeFromJsonElement

/** Every decode is lenient: a field a newer server adds, or one it drops, costs that field and never the frame. */
val wireJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    isLenient = true
}

class DrayError(message: String) : Exception(message)

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)?.takeUnless { it is JsonNull }

val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
val JsonElement?.int: Int? get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.let { it.intOrNull ?: it.doubleOrNull?.toInt() }
val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
val JsonElement?.double: Double? get() = (this as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
val JsonElement?.arr: List<JsonElement> get() = (this as? JsonArray) ?: emptyList()
val JsonElement?.obj: JsonObject? get() = this as? JsonObject

/** An error reply is usually a sentence and occasionally an object. */
val JsonElement.message: String get() = str ?: toString()

/** What `send_msg` tells the agent beside the reader's prompt: this phone, and its wall clock with its UTC offset, since a bot is told the reader's own time. Seconds always printed: `toString` drops `:00`, which RFC 3339 refuses. */
fun sentFrom(): Array<Pair<String, Any?>> = arrayOf(
    "device" to "android",
    "sentAt" to OffsetDateTime.now().truncatedTo(ChronoUnit.SECONDS).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
)

fun jsonOf(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (k, v) -> k to toJson(v) })

fun toJson(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    // Whole numbers go out as integers: serde refuses `1.0` for a `u32`.
    is Int -> JsonPrimitive(v)
    is Long -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is List<*> -> JsonArray(v.map { toJson(it) })
    is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJson(x) })
    else -> JsonPrimitive(v.toString())
}

inline fun <reified T> decodeOrNull(e: JsonElement?): T? =
    if (e == null || e is JsonNull) null else runCatching { wireJson.decodeFromJsonElement<T>(e) }.getOrNull()

/** One entry that may fail alone, so a bad one costs itself and not its list. */
inline fun <reified T> decodeList(e: JsonElement?): List<T> = e.arr.mapNotNull { decodeOrNull<T>(it) }

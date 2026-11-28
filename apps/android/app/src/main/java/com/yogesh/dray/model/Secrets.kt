package com.yogesh.dray.model

/** More saved secrets than this and the card's picker opens with a search. The desktop and iOS pickers use the same number. */
const val SECRET_SEARCH_AFTER = 6

/**
 * The saved names a search keeps, in their order: every word must appear in the name, case aside,
 * and `_` counts as a space, so "github token" finds GITHUB_TOKEN. The desktop's `matchSecrets`.
 */
fun matchSecrets(names: List<String>, query: String): List<String> {
    val words = query.lowercase().split(Regex("[\\s_]+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return names
    return names.filter { n -> val name = n.lowercase(); words.all { name.contains(it) } }
}

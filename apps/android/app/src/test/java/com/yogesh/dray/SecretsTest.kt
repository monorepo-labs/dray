package com.yogesh.dray

import com.yogesh.dray.model.matchSecrets
import org.junit.Assert.assertEquals
import org.junit.Test

class SecretsTest {
    private val names = listOf("GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "GH_TOKEN")

    @Test fun emptySearchKeepsAll() = assertEquals(names, matchSecrets(names, "  "))

    @Test fun matchesPartCaseAside() {
        assertEquals(listOf("NPM_TOKEN"), matchSecrets(names, "npm"))
        assertEquals(listOf("OPENAI_API_KEY"), matchSecrets(names, "Api"))
    }

    @Test fun underscoreIsASpaceAndEveryWordCounts() {
        assertEquals(listOf("GITHUB_TOKEN"), matchSecrets(names, "github token"))
        assertEquals(listOf("GH_TOKEN"), matchSecrets(names, "gh_tok"))
        assertEquals(listOf("GITHUB_TOKEN", "NPM_TOKEN", "GH_TOKEN"), matchSecrets(names, "token"))
    }

    @Test fun nothingMatches() = assertEquals(emptyList<String>(), matchSecrets(names, "stripe"))
}

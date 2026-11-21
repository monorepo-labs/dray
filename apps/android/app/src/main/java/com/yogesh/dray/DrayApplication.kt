package com.yogesh.dray

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.yogesh.dray.store.Store
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class DrayApplication : Application() {
    lateinit var store: Store
        private set

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            private var poll: Job? = null

            // Coming back to the front reconnects whatever dropped, and PR marks poll only while on screen.
            override fun onStart(owner: LifecycleOwner) {
                store.resume()
                poll = store.scope.launch {
                    while (true) {
                        store.pollMarks()
                        delay(30_000)
                    }
                }
            }

            override fun onStop(owner: LifecycleOwner) {
                poll?.cancel()
            }
        })
    }
}

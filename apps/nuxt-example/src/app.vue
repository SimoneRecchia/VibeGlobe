<template>
  <div class="app">
    <nav>
      <NuxtLink to="/" class="home">Home</NuxtLink>
      <NuxtLink to="/globe" class="to-globe">Globe</NuxtLink>
    </nav>
    <NuxtPage />
  </div>
</template>

<style>
html,
body,
#__nuxt,
.app {
  height: 100%;
  margin: 0;
  background: #0b1020;
  color: #ddd;
  font:
    14px system-ui,
    sans-serif;
}
.app {
  display: flex;
  flex-direction: column;
}
nav {
  display: flex;
  gap: 12px;
  padding: 8px;
}
nav a {
  color: #9cf;
}
</style>

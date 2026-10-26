#include <sys/types.h>
#include <sys/sysctl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* 只比较受控合成父进程的哨兵，绝不输出参数或环境正文。 */
int main(int argc, char **argv) {
  if (argc != 3) return 3;
  int pid = !strcmp(argv[1], "self") ? getpid() : atoi(argv[1]);
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 512 * 1024;
  char *buffer = malloc(size);
  if (!buffer) return 4;
  if (sysctl(mib, 3, buffer, &size, 0, 0)) { free(buffer); return 2; }
  size_t length = strlen(argv[2]);
  for (size_t i = 0; i + length <= size; i++) {
    if (!memcmp(buffer + i, argv[2], length)) { free(buffer); return 0; }
  }
  free(buffer);
  return 1;
}

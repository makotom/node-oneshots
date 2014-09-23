import os
import sys
import socket
import msvcrt

def initSocket():
	s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
	s.connect(("localhost", (int(sys.argv[1]) if len(sys.argv) > 1 else 37320)))
	return s

p = sys.stdin.detach().fileno()
s = initSocket()

msvcrt.setmode(p, os.O_BINARY)

while True:
	while True:
		hFromPipe = os.read(p, 8)
		try:
			s.sendall(hFromPipe)
		except:
			s = initSocket()
			s.sendall(hFromPipe)

		cFromPipe = os.read(p, 256 * hFromPipe[4] + hFromPipe[5])
		s.sendall(cFromPipe)

		if (hFromPipe[1] == 5 and len(cFromPipe) == 0):
			break

	while True:
		hFromSock = s.recv(8)
		os.write(p, hFromSock)

		cFromSock = s.recv(256 * hFromSock[4] + hFromSock[5])
		os.write(p, cFromSock)

		if (hFromSock[1] == 3):
			break

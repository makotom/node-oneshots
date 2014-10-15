import os
import sys
import socket
import msvcrt

def initSocket():
	s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
	s.connect(("localhost", (int(sys.argv[1]) if len(sys.argv) > 1 else 37320)))
	return s

def main():
	p = sys.stdin.detach().fileno()
	s = initSocket()

	msvcrt.setmode(p, os.O_BINARY)

	while True:
		while True:
			hFromPipe = os.read(p, 8)

			if (len(hFromPipe) < 8):
				return

			cFromPipe = os.read(p, 256 * hFromPipe[4] + hFromPipe[5])

			if (hFromPipe[1] == 2):
				continue

			try:
				s.sendall(hFromPipe)
				s.sendall(cFromPipe)
			except:
				s = initSocket()
				s.sendall(hFromPipe)
				s.sendall(cFromPipe)

			if (hFromPipe[1] == 5 and len(cFromPipe) == 0):
				break

		while True:
			hFromSock = s.recv(8)

			if (len(hFromSock) < 8):
				return

			cFromSock = s.recv(256 * hFromSock[4] + hFromSock[5])

			os.write(p, hFromSock)
			os.write(p, cFromSock)

			if (hFromSock[1] == 3):
				break

if __name__ == "__main__":
	main()
